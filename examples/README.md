# Examples

- `static-site/`: a directory with an `index.html`. `wtp up` serves it with the
  built-in static server, no config needed.
- `node-dev-server/`: a `package.json` with a `dev` script and a
  `.worktree-preview.json`. The server reads `PORT`.
- `systemd/wtp@.service`: a user unit that ties a preview to a unit's lifetime.

To try one, copy it into a git repository, commit it, add a worktree and run
`wtp up` inside it:

```sh
git worktree add ../try-it -b try-it
wtp up ../try-it
```
