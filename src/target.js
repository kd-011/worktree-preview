import fs from 'node:fs';
import path from 'node:path';
import { EXIT, WtpError } from './errors.js';
import { worktreeInfo } from './git.js';

/**
 * Turn the `name|path` argument of down/logs into a registry entry.
 * Returns { entry } or { entry: null, where } when the argument is a real
 * directory that simply has no preview. Throws for an unknown name.
 */
export async function resolveTarget(entries, arg, cwd = process.cwd()) {
  if (arg === undefined) {
    const info = await worktreeInfo(cwd);
    return { entry: entries.find((e) => e.path === info.root) ?? null, where: info.root };
  }
  const byName = entries.find((e) => e.name === arg);
  if (byName) return { entry: byName };

  const abs = path.resolve(cwd, arg);
  const candidates = new Set([abs]);
  let exists = false;
  try {
    exists = fs.statSync(abs).isDirectory();
    if (exists) {
      candidates.add(fs.realpathSync(abs));
      candidates.add((await worktreeInfo(abs)).root);
    }
  } catch {
    // not a git directory: the plain path candidates still apply
  }
  const byPath = entries.find((e) => candidates.has(e.path));
  if (byPath) return { entry: byPath };
  if (exists) return { entry: null, where: abs };
  throw new WtpError(`no preview named or located at "${arg}" (see: wtp ls)`, EXIT.USAGE);
}
