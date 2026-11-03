import { spawn } from 'node:child_process';
import { EXIT, WtpError } from './errors.js';
import { killGroup } from './proc.js';

/**
 * Run an install command in the worktree. Its output goes to stderr so stdout
 * stays the URL (or the JSON object). Resolves true when it finished, false
 * when `signal` aborted it first (the install's process group is stopped).
 */
export async function runInstall(cmd, cwd, signal) {
  const child = spawn('/bin/sh', ['-c', `${cmd}\nexit $?`], { cwd, detached: true, stdio: ['ignore', 2, 2] });
  const run = { exited: null, error: null };
  const finished = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve((run.exited = { code, sig })));
    child.once('error', (e) => resolve((run.error = e)));
  });
  const abort = async () => {
    await killGroup(child.pid).catch(() => {});
  };
  if (signal.aborted) await abort();
  else signal.addEventListener('abort', abort, { once: true });
  await finished;
  signal.removeEventListener('abort', abort);
  if (signal.aborted) return false;
  if (run.error) throw new WtpError(`could not run "${cmd}": ${run.error.message}`, EXIT.FAILED);
  const { code, sig } = run.exited;
  if (code !== 0) throw new WtpError(`"${cmd}" ${sig ? `was killed by ${sig}` : `exited with code ${code}`}; nothing was started`, EXIT.FAILED);
  return true;
}
