import fs from 'node:fs';
import { EXIT, WtpError } from '../errors.js';
import { Store } from '../state.js';
import { resolveTarget } from '../target.js';
import { sleep } from '../util.js';
import { tailLines } from './up.js';

export async function logs(opts) {
  const store = new Store();
  const { entries } = store.list();
  if (!opts.target) throw new WtpError('usage: wtp logs <name|path> [-f] [-n LINES]', EXIT.USAGE);

  let file;
  try {
    const { entry } = await resolveTarget(entries, opts.target);
    file = entry?.log;
  } catch (e) {
    // A dead preview's entry is gone but its log is kept until `wtp gc`.
    const orphan = store.logFile(opts.target);
    if (fs.existsSync(orphan)) file = orphan;
    else throw e;
  }
  if (!file || !fs.existsSync(file)) throw new WtpError(`no log for "${opts.target}"`, EXIT.USAGE);

  const lines = tailLines(file, opts.lines ?? 50);
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  if (!opts.follow) return;

  let pos = fs.statSync(file).size;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => (stop = true));
  while (!stop) {
    await sleep(150);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // the preview was stopped and its log removed
    }
    if (size < pos) pos = 0; // truncated by a restart
    if (size > pos) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        process.stdout.write(buf);
      } finally {
        fs.closeSync(fd);
      }
      pos = size;
    }
  }
}
