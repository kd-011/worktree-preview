import fs from 'node:fs';
import path from 'node:path';
import { checkIdentity, stopEntry } from '../proc.js';
import { Store } from '../state.js';

export async function gc(opts) {
  const store = new Store();
  store.ensure();
  const done = { dead: 0, recycled: 0, stopped: 0, logs: 0, broken: 0 };
  const note = (msg) => process.stdout.write(`${msg}\n`);

  await store.withLock(async () => {
    const { entries, corrupt } = store.list();
    for (const f of corrupt) {
      fs.rmSync(f, { force: true });
      done.broken++;
      note(`removed unreadable registry file ${path.basename(f)}`);
    }
    for (const e of entries) {
      const id = await checkIdentity(e);
      if (id.status === 'gone') {
        store.remove(e.name);
        done.dead++;
        note(`removed dead preview ${e.name} (pid ${e.pid} is gone)`);
      } else if (id.status === 'foreign') {
        store.remove(e.name);
        done.recycled++;
        note(`removed stale entry ${e.name} (pid ${e.pid} was recycled by another process, left alone)`);
      } else if (id.status === 'orphaned') {
        await stopEntry(e);
        store.remove(e.name);
        done.stopped++;
        note(`stopped leftover processes of dead preview ${e.name}`);
      } else if (opts.worktreesGone && !fs.existsSync(e.path)) {
        await stopEntry(e);
        store.remove(e.name);
        store.removeLog(e.name);
        done.stopped++;
        note(`stopped ${e.name} (its worktree no longer exists)`);
      }
    }

    const names = new Set(store.list().entries.map((e) => e.name));
    for (const f of store.logFiles()) {
      if (!names.has(f.slice(0, -'.log'.length))) {
        fs.rmSync(path.join(store.logs, f), { force: true });
        done.logs++;
        note(`removed orphaned log ${f}`);
      }
    }
    for (const f of fs.readdirSync(store.previews)) {
      const full = path.join(store.previews, f);
      if (f.endsWith('.tmp') && Date.now() - (fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 60000) fs.rmSync(full, { force: true });
    }
  });

  const total = done.dead + done.recycled + done.stopped + done.logs + done.broken;
  note(total ? `gc: ${done.dead + done.recycled} stale entries removed, ${done.stopped} previews stopped, ${done.logs} orphaned logs removed` : 'gc: nothing to clean');
}
