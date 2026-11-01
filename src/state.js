// On-disk registry: one JSON file per preview plus one log per preview, under
// $XDG_STATE_HOME/worktree-preview. State deliberately never lives in /tmp, so
// a systemd unit with PrivateTmp= sees the same files as your shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WtpError } from './errors.js';
import { readProcess } from './proc.js';
import { sleep } from './util.js';

export function stateRoot(env = process.env) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(base, 'worktree-preview');
}

export class Store {
  constructor(root = stateRoot()) {
    this.root = root;
    this.previews = path.join(root, 'previews');
    this.logs = path.join(root, 'logs');
    this.lockFile = path.join(root, 'lock');
  }

  ensure() {
    // Entries record command lines, which can hold secrets: keep them private.
    fs.mkdirSync(this.previews, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.logs, { recursive: true, mode: 0o700 });
  }

  entryFile(name) {
    return path.join(this.previews, `${name}.json`);
  }

  logFile(name) {
    return path.join(this.logs, `${name}.log`);
  }

  /** { entries, corrupt } where corrupt lists unreadable entry files. */
  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.previews);
    } catch {
      return { entries: [], corrupt: [] };
    }
    const entries = [];
    const corrupt = [];
    for (const f of files.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
      const file = path.join(this.previews, f);
      try {
        const e = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof e?.name !== 'string' || !Number.isInteger(e.pid) || !Number.isInteger(e.pgid)) throw new Error('bad shape');
        entries.push(e);
      } catch {
        corrupt.push(file);
      }
    }
    return { entries, corrupt };
  }

  read(name) {
    return this.list().entries.find((e) => e.name === name) ?? null;
  }

  /** Atomic: write a temp file in the same directory, then rename over the target. */
  write(entry) {
    this.ensure();
    const tmp = path.join(this.previews, `.${entry.name}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.entryFile(entry.name));
  }

  /** Update an existing entry only; never resurrects one that was removed meanwhile. */
  update(name, patch) {
    const cur = this.read(name);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.write(next);
    return next;
  }

  remove(name) {
    fs.rmSync(this.entryFile(name), { force: true });
  }

  removeLog(name) {
    fs.rmSync(this.logFile(name), { force: true });
  }

  logFiles() {
    try {
      return fs.readdirSync(this.logs).filter((f) => f.endsWith('.log'));
    } catch {
      return [];
    }
  }

  /**
   * Mutual exclusion between wtp processes. The lock file names its owner by
   * pid and start time, so a lock left by a crashed process is recognised as
   * stale and taken over, while a recycled pid is not mistaken for a live owner.
   */
  async withLock(fn, { timeoutMs = 20000 } = {}) {
    this.ensure();
    const me = await readProcess(process.pid);
    const token = `${process.pid} ${me?.startTime ?? ''}\n`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        fs.writeFileSync(this.lockFile, token, { flag: 'wx' });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      if (await this.#lockIsStale()) {
        await this.#stealStaleLock();
        continue;
      }
      if (Date.now() > deadline) throw new WtpError(`timed out waiting for the wtp lock (${this.lockFile})`);
      await sleep(25 + Math.random() * 25);
    }
    try {
      return await fn();
    } finally {
      try {
        if (fs.readFileSync(this.lockFile, 'utf8') === token) fs.rmSync(this.lockFile, { force: true });
      } catch {
        // already gone
      }
    }
  }

  async #lockIsStale() {
    let text;
    try {
      text = fs.readFileSync(this.lockFile, 'utf8');
    } catch {
      return false; // released between our attempt and now: just retry
    }
    const [pidStr, ...rest] = text.trim().split(' ');
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) {
      // Half-written lock: only stale once it has been sitting there a while.
      return Date.now() - fs.statSync(this.lockFile, { throwIfNoEntry: false })?.mtimeMs > 2000;
    }
    const p = await readProcess(pid);
    return !p || p.state === 'Z' || String(p.startTime) !== rest.join(' ');
  }

  async #stealStaleLock() {
    // Only one stealer at a time, so two of them cannot each delete the
    // other's freshly created lock.
    const guard = `${this.lockFile}.steal`;
    try {
      fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') {
        const age = Date.now() - (fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > 5000) fs.rmSync(guard, { force: true });
        await sleep(25);
        return;
      }
      throw e;
    }
    try {
      if (await this.#lockIsStale()) fs.rmSync(this.lockFile, { force: true });
    } finally {
      fs.rmSync(guard, { force: true });
    }
  }
}
