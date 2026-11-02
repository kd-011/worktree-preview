# Security

## Reporting a vulnerability

Please use GitHub private vulnerability reporting: open the Security tab of this repository and choose "Report a vulnerability". That keeps the report private until a fix is out. Please don't open a public issue for something exploitable.

Tell me what you ran, what you expected and what happened. A small repository that reproduces it helps most.

## What is in scope

worktree-preview starts a server in a git worktree, records it, and later signals the process group it started. It makes no network calls of its own. The areas most worth a look are:

- Process identity checks and signalling in `src/proc.js`: a case where `wtp down`, `gc` or `ls` signals a process it did not start.
- Path handling in the built-in static server (`src/static-server.js`): anything that serves a file outside the worktree, through encoding tricks or symlinks.
- File permissions of the state directory, which holds command lines.

## What is not a vulnerability

`wtp up` runs the command named by `--cmd`, `.worktree-preview.json` or the `dev` script in `package.json`, with your permissions and no confirmation, exactly like `npm run dev`. The README says so. The risk is pointing it at a checkout you do not trust. That is documented, not guarded.

## Supported versions

Only the latest release gets fixes. The project is small and has no runtime dependencies.
