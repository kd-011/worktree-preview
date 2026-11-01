import { isBindable } from '../ports.js';
import { stopEntry } from '../proc.js';
import { Store } from '../state.js';
import { resolveTarget } from '../target.js';

/** Stop one registered preview and forget it. Returns true when it was running. */
export async function stopAndForget(store, entry, { removeLog = true } = {}) {
  const r = await stopEntry(entry);
  store.remove(entry.name);
  if (removeLog) store.removeLog(entry.name);
  if (r.result === 'foreign') {
    process.stderr.write(
      `wtp: ${entry.name}: pid ${entry.pid} is no longer the process wtp started (the pid was recycled), so it was left alone; the stale entry was dropped\n`,
    );
    return false;
  }
  if (r.result === 'gone') {
    process.stderr.write(`wtp: ${entry.name}: already stopped, entry removed\n`);
    return false;
  }
  const how = r.how === 'kill' ? ' (needed SIGKILL)' : '';
  process.stdout.write(`stopped ${entry.name}${how}\n`);
  if (!(await isBindable(entry.port))) {
    process.stderr.write(
      `wtp: warning: port ${entry.port} is still in use by something outside the preview's process group; it was not touched\n`,
    );
  }
  return true;
}

export async function down(opts) {
  const store = new Store();
  const { entries } = store.list();

  if (opts.all) {
    if (!entries.length) {
      process.stderr.write('wtp: no previews to stop\n');
      return;
    }
    for (const e of entries) await stopAndForget(store, e);
    return;
  }

  const { entry, where } = await resolveTarget(entries, opts.target, process.cwd());
  if (!entry) {
    process.stderr.write(`wtp: nothing to stop: no preview is registered for ${where}\n`);
    return;
  }
  await stopAndForget(store, entry);
}
