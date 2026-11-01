import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CONFIG_FILE, detectCommand, loadConfig } from '../detect.js';
import { EXIT, WtpError } from '../errors.js';
import { branchOf, worktreeInfo } from '../git.js';
import { isBindable, portCandidates, rangeFromEnv } from '../ports.js';
import { checkIdentity, readProcess, stopEntry } from '../proc.js';
import { isReady, probe } from '../ready.js';
import { Store } from '../state.js';
import { NAME_RE, defaultName, hash, sleep } from '../util.js';

const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const TAIL_LINES = 20;

export function tailLines(file, n) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 1 << 20);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n);
}

function say(msg) {
  process.stderr.write(`wtp: ${msg}\n`);
}

/** Pick a name that is free, or fail if the user insisted on one that is not. */
function chooseName(entries, root, explicit) {
  if (explicit) {
    const clash = entries.find((e) => e.name === explicit && e.path !== root);
    if (clash) throw new WtpError(`the name "${explicit}" is already used by the preview for ${clash.path}`, EXIT.USAGE);
    return explicit;
  }
  const base = defaultName(root);
  for (const candidate of [base, `${base}-${hash(root).slice(0, 4)}`, `${base}-${hash(root).slice(0, 10)}`]) {
    if (!entries.some((e) => e.name === candidate && e.path !== root)) return candidate;
  }
  throw new WtpError('could not find a free preview name; pass --name');
}

/**
 * Under the lock: tidy the registry, return the live preview for this worktree
 * if there is one, otherwise claim a port and start the server.
 */
async function decide(store, ctx) {
  const { root, branch, opts, config } = ctx;
  const { entries, corrupt } = store.list();
  for (const f of corrupt) {
    fs.rmSync(f, { force: true });
    say(`removed unreadable registry file ${f}`);
  }

  const live = [];
  for (const e of entries) {
    const id = await checkIdentity(e);
    if (id.status === 'ours') {
      live.push(e);
      continue;
    }
    if (id.status === 'orphaned') {
      await stopEntry(e);
      say(`stopped leftover processes of dead preview ${e.name}`);
    } else if (id.status === 'foreign') {
      say(`dropped stale entry ${e.name}: pid ${e.pid} now belongs to another process and was left alone`);
    }
    store.remove(e.name);
  }

  const existing = live.find((e) => e.path === root);
  if (existing) return { kind: 'existing', entry: existing };

  const cmd = opts.cmd ?? config.cmd ?? detectCommand(root)?.cmd;
  if (!cmd) {
    throw new WtpError(
      `nothing to run in ${root}: pass --cmd "...", add a ${CONFIG_FILE} with a "cmd", add a "dev" script to package.json, or add an index.html`,
      EXIT.USAGE,
    );
  }

  const remaining = store.list().entries;
  const name = chooseName(remaining, root, opts.name);
  const claimed = new Map(live.map((e) => [e.port, e.name]));
  const range = rangeFromEnv();

  const explicit = opts.port !== undefined;
  const candidates = explicit ? [opts.port] : portCandidates(root, range);
  for (const port of candidates) {
    if (claimed.has(port)) {
      if (explicit) throw new WtpError(`port ${port} is already in use by the preview "${claimed.get(port)}"`);
      continue;
    }
    // Verify by actually binding, immediately before the spawn.
    if (!(await isBindable(port))) {
      if (explicit) throw new WtpError(`port ${port} is already in use by another process; pick a different --port or omit it to choose one automatically`);
      continue;
    }
    if (ctx.isInterrupted()) throw ctx.interruptError();
    return { kind: 'started', ...startServer(store, { root, branch, name, port, cmd, config }) };
  }
  throw new WtpError(`no free port in ${range.lo}-${range.hi}; stop a preview (wtp ls) or set WTP_PORT_RANGE`);
}

function startServer(store, { root, branch, name, port, cmd, config }) {
  const log = store.logFile(name);
  const fd = fs.openSync(log, 'w', 0o600);
  const env = { ...process.env, PORT: String(port), WTP_PORT: String(port), WTP_NAME: name, [config.port_env]: String(port) };
  // The trailing `exit` stops the shell from exec-ing a single command, so the
  // process we register stays the shell and its identity does not change.
  const script = `${cmd}\nexit $?`;
  const child = spawn('/bin/sh', ['-c', script], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const run = { exited: null, error: null };
  child.once('exit', (code, signal) => (run.exited = { code, signal }));
  child.once('error', (e) => (run.error = e));
  return { child, run, root, branch, name, port, cmd, log, config };
}

async function register(store, s) {
  if (!s.child.pid) throw new WtpError(`could not start the command: ${s.run.error?.message ?? 'spawn failed'}`);
  const proc = await readProcess(s.child.pid);
  const entry = {
    name: s.name,
    path: s.root,
    branch: s.branch,
    port: s.port,
    pid: s.child.pid,
    pgid: s.child.pid,
    start_time: proc?.startTime ?? null,
    cmdline: proc?.cmdline ?? null,
    cmd: s.cmd,
    started_at: new Date().toISOString(),
    log: s.log,
    status: 'starting',
    port_env: s.config.port_env,
    ready_path: s.config.ready_path,
  };
  if (!proc) {
    // Gone before we could even identify it. Sweep the group; nothing is registered.
    entry.start_time = '0';
    entry.cmdline = '';
  }
  store.write(entry);
  return entry;
}

/** Poll until the port answers, the process dies, the deadline passes or we are interrupted. */
async function waitReady({ entry, run, deadline, ac, isInterrupted }) {
  let lastStatus = null;
  for (;;) {
    if (isInterrupted()) return { outcome: 'interrupted' };
    if (run?.exited || run?.error) return { outcome: 'died', exited: run.exited, error: run.error };
    const r = await probe(entry.port, entry.ready_path, { signal: ac.signal });
    if (isInterrupted()) return { outcome: 'interrupted' };
    if (isReady(r) && !(run?.exited || run?.error)) return { outcome: 'ready' };
    if (r.status !== null) lastStatus = r.status;
    if (Date.now() > deadline) return { outcome: 'timeout', lastStatus };
    await sleep(100);
  }
}

/** Teardown for a preview this very process started and still holds a handle on. */
async function teardownOwn(store, entry, child) {
  // A command that exec'd changes the shell's command line; the pid and start
  // time still prove it is ours, so refresh the record before the identity check.
  if (child.exitCode === null && child.signalCode === null) {
    const p = await readProcess(entry.pid);
    if (p && String(p.startTime) === String(entry.start_time)) entry.cmdline = p.cmdline;
  }
  await stopEntry(entry);
  store.remove(entry.name);
}

function failure(message, entry) {
  const err = new WtpError(message, EXIT.FAILED);
  const lines = tailLines(entry.log, TAIL_LINES);
  err.details = lines.length ? lines.join('\n') : '(the log is empty)';
  err.detailsHeader = `last ${TAIL_LINES} lines of ${entry.log}:`;
  return err;
}

function describeExit(run) {
  if (run.error) return `could not be started (${run.error.message})`;
  const { code, signal } = run.exited;
  return signal ? `was killed by ${signal}` : `exited with code ${code}`;
}

function portHint() {
  return (
    `The server may be ignoring $PORT. Either set "port_env" in ${CONFIG_FILE} to the variable it reads, ` +
    `or use $PORT in the command, for example --cmd 'my-server --port $PORT'.`
  );
}

function openBrowser(url) {
  const bin = process.env.BROWSER || (process.platform === 'darwin' ? 'open' : 'xdg-open');
  try {
    const c = spawn(bin, [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => say(`could not open a browser (${bin}); the URL is ${url}`));
    c.unref();
  } catch {
    say(`could not open a browser (${bin}); the URL is ${url}`);
  }
}

function report(entry, opts) {
  const url = `http://localhost:${entry.port}`;
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ name: entry.name, url, port: entry.port, pid: entry.pid, log: entry.log, path: entry.path, branch: entry.branch }) + '\n',
    );
  } else {
    process.stdout.write(`${url}\n`);
  }
  if (opts.open) openBrowser(url);
}

/** Someone else (or an earlier run) started it: wait for it to answer, never kill it. */
async function waitForExisting(store, name, { deadline, ac, isInterrupted, interruptError }) {
  for (;;) {
    if (isInterrupted()) throw interruptError();
    const cur = store.read(name);
    if (!cur) return null;
    const id = await checkIdentity(cur);
    if (id.status !== 'ours') return null;
    const r = await probe(cur.port, cur.ready_path ?? '/', { signal: ac.signal });
    if (isReady(r)) return cur;
    if (Date.now() > deadline) {
      throw new WtpError(
        `the preview "${name}" is running (pid ${cur.pid}) but port ${cur.port} did not answer in time; see: wtp logs ${name}, stop it with: wtp down ${name}`,
      );
    }
    await sleep(150);
  }
}

export async function up(opts) {
  const info = await worktreeInfo(opts.path ?? process.cwd());
  const config = loadConfig(info.root);
  if (opts.name !== undefined && !NAME_RE.test(opts.name)) {
    throw new WtpError(`invalid --name "${opts.name}": use lowercase letters, digits, ".", "_" and "-"`, EXIT.USAGE);
  }
  const waitSeconds = opts.wait ?? config.ready_timeout ?? 60;
  const deadline = Date.now() + waitSeconds * 1000;
  const store = new Store();
  store.ensure();

  // Installed before anything is spawned, so an interrupt can never find a
  // half-started preview without a handler to clean it up.
  const ac = new AbortController();
  let interrupted = null;
  const handlers = Object.keys(SIGNAL_EXIT).map((sig) => {
    const h = () => {
      interrupted ??= sig;
      ac.abort();
    };
    process.on(sig, h);
    return [sig, h];
  });
  const isInterrupted = () => interrupted !== null;
  const interruptError = () => new WtpError(`interrupted by ${interrupted}; the preview that was starting has been stopped`, SIGNAL_EXIT[interrupted]);

  try {
    for (;;) {
      const decision = await store.withLock(async () => {
        const d = await decide(store, { root: info.root, branch: info.branch, opts, config, isInterrupted, interruptError });
        if (d.kind === 'started') d.entry = await register(store, d);
        return d;
      });

      if (decision.kind === 'existing') {
        const ready = await waitForExisting(store, decision.entry.name, { deadline, ac, isInterrupted, interruptError });
        if (!ready) continue; // it vanished while we waited: try to start it ourselves
        const branch = await branchOf(ready.path).catch(() => ready.branch);
        report({ ...ready, branch }, opts);
        return;
      }

      const { entry, child, run } = decision;
      const result = await waitReady({ entry, run, deadline, ac, isInterrupted });

      if (result.outcome === 'ready') {
        const p = await readProcess(entry.pid);
        const patch = { status: 'up' };
        if (p && String(p.startTime) === String(entry.start_time)) patch.cmdline = p.cmdline;
        const saved = store.update(entry.name, patch);
        if (!saved) throw new WtpError(`the preview "${entry.name}" was stopped by another wtp command while it was starting`);
        child.unref();
        report(entry, opts);
        return;
      }

      await teardownOwn(store, entry, child);
      if (result.outcome === 'interrupted') throw interruptError();
      if (result.outcome === 'died') throw failure(`the server ${describeExit(result)} before port ${entry.port} answered`, entry);
      const last = result.lastStatus ? ` (the last answer was HTTP ${result.lastStatus}, which is not ready)` : '';
      throw failure(
        `nothing ready on port ${entry.port} after ${waitSeconds}s: GET ${entry.ready_path} must answer with a non-5xx status${last}. ${portHint()}`,
        entry,
      );
    }
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}
