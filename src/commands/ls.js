import fs from 'node:fs';
import { branchOf } from '../git.js';
import { isListening } from '../ports.js';
import { checkIdentity, stopEntry } from '../proc.js';
import { Store } from '../state.js';
import { formatUptime, table } from '../util.js';

/** Work out the state of every entry, removing the ones that are dead. */
export async function inspectAll(store) {
  const { entries, corrupt } = store.list();
  for (const f of corrupt) {
    fs.rmSync(f, { force: true });
    process.stderr.write(`wtp: removed unreadable registry file ${f}\n`);
  }
  const rows = [];
  for (const e of entries) {
    const id = await checkIdentity(e);
    let state;
    if (id.status === 'ours') {
      state = (await isListening(e.port)) ? 'up' : e.status === 'starting' ? 'starting' : 'unhealthy';
    } else {
      state = 'dead';
      if (id.status === 'orphaned') {
        await stopEntry(e);
        process.stderr.write(`wtp: removed dead preview ${e.name} (its leader process is gone; stopped the leftover processes of its group)\n`);
      } else if (id.status === 'foreign') {
        process.stderr.write(`wtp: removed dead preview ${e.name} (pid ${e.pid} now belongs to another process and was left alone)\n`);
      } else {
        process.stderr.write(`wtp: removed dead preview ${e.name} (pid ${e.pid} is gone)\n`);
      }
      store.remove(e.name);
    }
    const missing = !fs.existsSync(e.path);
    rows.push({
      name: e.name,
      branch: missing ? e.branch : await branchOf(e.path).catch(() => e.branch),
      worktree_missing: missing,
      path: e.path,
      port: e.port,
      pid: e.pid,
      pgid: e.pgid,
      uptime_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(e.started_at)) / 1000)),
      url: `http://localhost:${e.port}`,
      state,
      log: e.log,
    });
  }
  return rows;
}

export async function ls(opts) {
  const rows = await inspectAll(new Store());
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  if (!rows.length) {
    process.stdout.write('no previews\n');
    return;
  }
  const view = rows.map((r) => ({
    ...r,
    branch: r.worktree_missing ? `${r.branch} (worktree missing)` : r.branch,
    uptime: formatUptime(r.uptime_seconds),
  }));
  process.stdout.write(table(view, ['name', 'branch', 'port', 'pid', 'uptime', 'url', 'state']) + '\n');
}
