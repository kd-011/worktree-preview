export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NOT_A_WORKTREE: 3 };

/** An error that maps to a documented exit code and a one-line message. */
export class WtpError extends Error {
  constructor(message, exitCode = EXIT.FAILED) {
    super(message);
    this.name = 'WtpError';
    this.exitCode = exitCode;
  }
}
