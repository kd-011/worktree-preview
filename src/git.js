import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { EXIT, WtpError } from './errors.js';

const execFileP = promisify(execFile);

async function git(cwd, ...args) {
  try {
    const { stdout } = await execFileP('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } });
    return stdout.trim();
  } catch (e) {
    if (e.code === 'ENOENT' && e.syscall?.startsWith('spawn git')) throw new WtpError('git was not found on PATH', EXIT.USAGE);
    throw e;
  }
}

export async function branchOf(dir) {
  try {
    return await git(dir, 'symbolic-ref', '--short', '-q', 'HEAD');
  } catch {
    try {
      return `(detached ${await git(dir, 'rev-parse', '--short', 'HEAD')})`;
    } catch {
      return '(unknown)';
    }
  }
}

/** Resolve any path inside a git worktree (or the main checkout) to its root. */
export async function worktreeInfo(target) {
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    throw new WtpError(`path does not exist: ${target}`, EXIT.USAGE);
  }
  if (!st.isDirectory()) throw new WtpError(`not a directory: ${target}`, EXIT.USAGE);
  let top;
  try {
    top = await git(target, 'rev-parse', '--show-toplevel');
  } catch (e) {
    if (e instanceof WtpError) throw e;
    throw new WtpError(`not a git worktree: ${target}`, EXIT.NOT_A_WORKTREE);
  }
  const root = fs.realpathSync(top);
  return { root, branch: await branchOf(root) };
}
