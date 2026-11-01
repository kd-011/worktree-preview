import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isBindable, rangeFromEnv } from '../ports.js';
import { Store } from '../state.js';

const execFileP = promisify(execFile);

function atLeast(version, min) {
  const a = version.split('.').map(Number);
  for (let i = 0; i < min.length; i++) {
    if ((a[i] ?? 0) > min[i]) return true;
    if ((a[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export async function doctor() {
  let failed = false;
  const line = (level, msg) => {
    if (level === 'FAIL') failed = true;
    process.stdout.write(`${level.padEnd(4)}  ${msg}\n`);
  };

  if (process.platform === 'win32') line('FAIL', 'platform win32 is not supported (Linux and macOS only)');
  else line('ok', `platform ${process.platform}`);

  const nodeVersion = process.versions.node;
  line(atLeast(nodeVersion, [22]) ? 'ok' : 'FAIL', `node ${nodeVersion} (needs 22 or newer)`);

  try {
    const { stdout } = await execFileP('git', ['--version']);
    const v = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1] ?? '';
    line(atLeast(v, [2, 5]) ? 'ok' : 'FAIL', `git ${v} (needs 2.5 or newer for worktrees)`);
  } catch {
    line('FAIL', 'git not found on PATH');
  }

  const store = new Store();
  try {
    store.ensure();
    const probe = path.join(store.root, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    line('ok', `state dir ${store.root} is writable`);
  } catch (e) {
    line('FAIL', `state dir ${store.root} is not writable (${e.code ?? e.message})`);
  }

  const range = rangeFromEnv();
  const size = range.hi - range.lo + 1;
  let free = 0;
  for (let p = range.lo; p <= range.hi; p += 10) {
    const batch = [];
    for (let q = p; q < Math.min(p + 10, range.hi + 1); q++) batch.push(isBindable(q));
    free += (await Promise.all(batch)).filter(Boolean).length;
  }
  line(free === 0 ? 'FAIL' : free < size / 10 ? 'warn' : 'ok', `port range ${range.lo}-${range.hi}: ${free}/${size} free`);

  const { entries } = store.list();
  line('ok', `${entries.length} preview${entries.length === 1 ? '' : 's'} registered`);
  return failed ? 1 : 0;
}
