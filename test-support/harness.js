// Shared helpers for the acceptance tests. Lives outside test/ because
// `node --test` runs every .js file inside a directory named test.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const WTP = path.join(ROOT, 'bin', 'wtp.js');
export const FIXTURES = path.join(here, 'fixtures');
export const NODE = process.execPath;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function q(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

/** Shell command line that runs a fixture script with the current node. */
export function nodeCmd(fixture) {
  return `${q(NODE)} ${q(path.join(FIXTURES, fixture))}`;
}

export async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export function httpGet(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

/** Raw request line over a socket, so nothing normalises the path for us. */
export function rawGet(port, target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    sock.on('data', (c) => (data += c));
    sock.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1]), head, body: rest.join('\r\n\r\n') });
    });
    sock.on('error', reject);
  });
}

function procState(pid) {
  if (process.platform === 'linux') {
    try {
      const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return s.slice(s.lastIndexOf(')') + 2)[0];
    } catch {
      return null;
    }
  }
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0] || null;
  } catch {
    return null;
  }
}

/** True when the pid is a live, non-zombie process. */
export function isAlive(pid) {
  const st = procState(pid);
  return st !== null && st !== 'Z';
}

export function listens(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host }, () => s.close(() => resolve(true)));
  });
}

/** True when nothing holds the port on any common bind address. */
export async function canBind(port) {
  return (await listens(port, '0.0.0.0')) && (await listens(port, '127.0.0.1'));
}

let sandboxCount = 0;

export class Sandbox {
  constructor({ portBase, portCount = 40 } = {}) {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-test-')));
    this.stateHome = path.join(this.root, 'state');
    this.pidDir = path.join(this.root, 'pids');
    this.home = path.join(this.root, 'home');
    for (const d of [this.stateHome, this.pidDir, this.home]) fs.mkdirSync(d, { recursive: true });
    this.range = { lo: portBase, hi: portBase + portCount - 1 };
    this.env = {
      ...process.env,
      HOME: this.home,
      XDG_STATE_HOME: this.stateHome,
      WTP_PORT_RANGE: `${this.range.lo}-${this.range.hi}`,
      WTP_TEST_PIDS: this.pidDir,
      WTP_TERM_GRACE_MS: '1500',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    delete this.env.BROWSER;
    this.children = [];
    this.blockers = [];
    this.decoys = [];
    this.id = ++sandboxCount;
  }

  get stateDir() {
    return path.join(this.stateHome, 'worktree-preview');
  }
  get previewsDir() {
    return path.join(this.stateDir, 'previews');
  }
  get logsDir() {
    return path.join(this.stateDir, 'logs');
  }

  git(cwd, ...args) {
    return execFileSync('git', args, { cwd, env: this.env, encoding: 'utf8' }).trim();
  }

  repo(name = 'repo') {
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true });
    this.git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# scratch\n');
    this.git(dir, 'add', '.');
    this.git(dir, 'commit', '-q', '-m', 'init');
    return fs.realpathSync(dir);
  }

  worktree(repo, name, branch) {
    const dir = path.join(this.root, name);
    this.git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
    return fs.realpathSync(dir);
  }

  write(dir, file, content) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }

  /** Spawn the CLI without waiting. Returns { child, done }. */
  start(args, { cwd = this.root, env = {}, detached = false } = {}) {
    const child = spawn(NODE, [WTP, ...args], {
      cwd,
      env: { ...this.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    });
    this.children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const done = new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, done, output: () => ({ stdout, stderr }) };
  }

  async run(args, opts = {}) {
    const { timeout = 90000, ...rest } = opts;
    const { child, done } = this.start(args, rest);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `wtp up` with the given fixture as the command. */
  up(cwd, fixture, extra = [], opts = {}) {
    return this.run(['up', '--cmd', nodeCmd(fixture), ...extra], { cwd, ...opts });
  }

  async json(args, opts) {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new Error(`wtp ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  entries() {
    let files = [];
    try {
      files = fs.readdirSync(this.previewsDir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.previewsDir, f), 'utf8')));
  }

  /** Write a registry entry by hand, as if wtp had started something. */
  plant(entry) {
    fs.mkdirSync(this.previewsDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
    const full = {
      path: this.root,
      branch: 'main',
      port: this.range.lo + 30,
      cmd: 'true',
      cmdline: '/bin/sh -c true',
      started_at: new Date().toISOString(),
      log: path.join(this.logsDir, `${entry.name}.log`),
      ...entry,
    };
    fs.writeFileSync(path.join(this.previewsDir, `${full.name}.json`), JSON.stringify(full, null, 2));
    return full;
  }

  pids() {
    try {
      return fs.readdirSync(this.pidDir).map(Number).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** A live process that has nothing to do with wtp, in its own process group. */
  decoy() {
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    this.decoys.push(child);
    return child;
  }

  /** Listen on a port the way a stray dev server would. */
  async blocker(port, host = '127.0.0.1') {
    const s = net.createServer((c) => c.end());
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen({ port, host }, resolve);
    });
    this.blockers.push(s);
    return s;
  }

  async leaks() {
    const problems = [];
    const left = this.entries();
    if (left.length) problems.push(`registry entries left: ${left.map((e) => e.name).join(', ')}`);
    const pids = this.pids();
    const end = Date.now() + 1500;
    let alive = pids.filter(isAlive);
    while (alive.length && Date.now() < end) {
      await sleep(50);
      alive = pids.filter(isAlive);
    }
    if (alive.length) problems.push(`processes still alive: ${alive.join(', ')}`);
    const held = [];
    for (let p = this.range.lo; p <= this.range.hi; p++) {
      if (this.blockers.some((b) => b.address()?.port === p)) continue;
      if (!(await canBind(p))) held.push(p);
    }
    if (held.length) problems.push(`ports still held: ${held.join(', ')}`);
    return problems;
  }

  async assertClean() {
    const problems = await this.leaks();
    if (problems.length) throw new Error(`not clean: ${problems.join('; ')}`);
  }

  /** Tear everything down and fail loudly if anything of ours is left. */
  async cleanup() {
    const problems = [];
    for (const b of this.blockers) await new Promise((r) => b.close(r));
    this.blockers = [];
    const r = await this.run(['down', '--all'], { timeout: 60000 }).catch((e) => ({ code: -1, stderr: String(e) }));
    if (r.code !== 0) problems.push(`down --all exited ${r.code}: ${r.stderr}`);
    problems.push(...(await this.leaks()));
    for (const pid of this.pids().filter(isAlive)) {
      try {
        process.kill(pid, 'SIGKILL'); // exact pid recorded by one of our fixtures
      } catch {}
    }
    for (const c of this.children) {
      if (c.exitCode === null && c.signalCode === null) {
        problems.push(`cli child ${c.pid} still running`);
        try {
          c.kill('SIGKILL');
        } catch {}
      }
    }
    for (const d of this.decoys) {
      try {
        process.kill(d.pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(this.root, { recursive: true, force: true });
    if (problems.length) throw new Error(`test leaked: ${problems.join('; ')}`);
  }
}
