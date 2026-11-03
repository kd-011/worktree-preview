// The rule everything else relies on: a registry entry only ever authorises a
// signal when the pid it names still has the start time, command line and
// process group that were recorded when we spawned it. A recycled pid fails
// that test and is left alone. Signals go to the whole process group, never to
// a name pattern.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { WtpError } from './errors.js';
import { sleep } from './util.js';

const execFileP = promisify(execFile);
const LINUX = process.platform === 'linux';
const PS_ENV = { ...process.env, LC_ALL: 'C' };

export function termGraceMs(env = process.env) {
  const raw = env.WTP_TERM_GRACE_MS;
  const v = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 5000;
}

function readLinux(pid) {
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // Field 2 (comm) may contain spaces and parentheses: split after the last ')'.
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replaceAll('\0', ' ');
  } catch {
    // process vanished between the two reads
    return null;
  }
  return { pid, state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), startTime: f[19], cmdline };
}

async function readPs(pid) {
  let out;
  try {
    ({ stdout: out } = await execFileP('ps', ['-ww', '-o', 'stat=,pgid=,ppid=,lstart=,command=', '-p', String(pid)], { env: PS_ENV }));
  } catch {
    return null;
  }
  const line = out.split('\n').find((l) => l.trim());
  if (!line) return null;
  const t = line.trim().split(/\s+/);
  if (t.length < 9) return null;
  return {
    pid,
    state: t[0][0],
    pgid: Number(t[1]),
    ppid: Number(t[2]),
    startTime: t.slice(3, 8).join(' '),
    cmdline: t.slice(8).join(' '),
  };
}

/** { pid, state, ppid, pgid, startTime, cmdline } or null when there is no such process. */
export async function readProcess(pid) {
  if (!Number.isInteger(pid) || pid < 2) return null;
  return LINUX ? readLinux(pid) : readPs(pid);
}

/** Live (non-zombie) members of a process group. */
export async function listGroup(pgid) {
  if (!Number.isInteger(pgid) || pgid < 2) return [];
  const members = [];
  if (LINUX) {
    let names;
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return [];
    }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
      } catch {
        continue;
      }
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) === pgid && f[0] !== 'Z') members.push({ pid: Number(n), state: f[0] });
    }
    return members;
  }
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,pgid=,stat='], { env: PS_ENV });
    for (const line of stdout.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (Number(t[1]) === pgid && t[2] && t[2][0] !== 'Z') members.push({ pid: Number(t[0]), state: t[2][0] });
    }
  } catch {
    // ps unavailable: report no members rather than guess
  }
  return members;
}

export async function ownGroup() {
  return (await readProcess(process.pid))?.pgid ?? null;
}

/**
 * Decide what a registry entry still refers to.
 *   ours      the recorded leader is alive and is exactly what we started
 *   orphaned  the leader is gone but members of its process group remain
 *   foreign   that pid now belongs to some other process: never touch it
 *   gone      nothing left
 */
export async function checkIdentity(entry) {
  const p = await readProcess(entry.pid);
  if (p && p.state !== 'Z') {
    const same =
      String(p.startTime) === String(entry.start_time) && p.cmdline === entry.cmdline && p.pgid === entry.pgid;
    return same ? { status: 'ours', proc: p } : { status: 'foreign', proc: p };
  }
  // A leader that is gone but whose pid number is still the id of a live group
  // cannot have been recycled: the kernel keeps the number reserved.
  const members = await listGroup(entry.pgid);
  return members.length ? { status: 'orphaned', members } : { status: 'gone' };
}

function signalGroup(pgid, sig) {
  if (!Number.isInteger(pgid) || pgid < 2) throw new WtpError(`refusing to signal process group ${pgid}`);
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw new WtpError(`cannot signal process group ${pgid}: ${e.message}`);
  }
}

async function waitGroupGone(pgid, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if ((await listGroup(pgid)).length === 0) return true;
    if (Date.now() >= end) return false;
    await sleep(25);
  }
}

/** SIGTERM the group, wait up to the grace period, then SIGKILL the group. */
export async function killGroup(pgid, graceMs = termGraceMs()) {
  if ((await ownGroup()) === pgid) throw new WtpError('refusing to signal wtp\'s own process group');
  if (!signalGroup(pgid, 'SIGTERM')) return 'gone';
  if (await waitGroupGone(pgid, graceMs)) return 'term';
  signalGroup(pgid, 'SIGKILL');
  if (await waitGroupGone(pgid, 3000)) return 'kill';
  throw new WtpError(`process group ${pgid} did not exit after SIGKILL`);
}

/**
 * Stop what an entry refers to, if and only if identity checks out.
 * Returns { result: 'stopped' | 'gone' | 'foreign', how }.
 */
export async function stopEntry(entry, graceMs) {
  const id = await checkIdentity(entry);
  if (id.status === 'foreign') return { result: 'foreign', how: null };
  if (id.status === 'gone') return { result: 'gone', how: null };
  const how = await killGroup(entry.pgid, graceMs);
  return { result: 'stopped', how, orphaned: id.status === 'orphaned' };
}
