# Reference

Everything `wtp` takes and prints. The [README](../README.md) has the short version.

## Commands

| Command | What it does |
| --- | --- |
| `wtp up [path] [--port N] [--cmd "..."] [--name X] [--wait 60] [--install] [--open] [--json]` | Start the preview for a worktree (default: the current directory) and print its URL. If one is already running and healthy, print its URL and exit 0. |
| `wtp ls [--json]` | Table of previews: name, branch, port, pid, uptime, url, state (`up`, `starting`, `dead`, or `unhealthy` when the process is alive but the port is silent). Dead entries are removed as it goes, and it says so. |
| `wtp logs <name\|path> [-f] [-n N]` | Show the last N lines (default 50) of the preview log; `-f` follows. |
| `wtp down [name\|path] [--all]` | Stop a preview. With no argument inside a worktree it stops that worktree's preview. `--all` stops every preview wtp started. |
| `wtp gc [--worktrees-gone]` | Remove dead entries and orphaned log files. With `--worktrees-gone`, also stop previews whose worktree directory no longer exists. |
| `wtp doctor` | Check git and node versions, that the state directory is writable, and how many ports of the range are free. |

`path` must be inside a git worktree or the main checkout. A subdirectory resolves to the worktree root.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | The server failed to start or never became healthy (or a port you demanded is taken) |
| 2 | Usage or config error (bad flag, bad `.worktree-preview.json`, nothing to run, unknown preview name) |
| 3 | Not a git worktree |
| 129 / 130 / 143 | `wtp up` was interrupted by SIGHUP / SIGINT / SIGTERM; what it had started was torn down |

### Machine-readable output

`wtp up --json` prints one object, `wtp ls --json` prints an array:

```json
{
  "name": "app-login",
  "url": "http://localhost:4197",
  "port": 4197,
  "pid": 2803591,
  "log": "<state dir>/logs/app-login.log",
  "path": "<worktree path>",
  "branch": "login"
}
```

`ls --json` entries carry `name`, `branch`, `worktree_missing`, `path`, `port`, `pid`, `pgid`, `uptime_seconds`, `url`, `state` and `log`. Messages for people go to stderr, so stdout is safe to parse.


## What command runs

In order of precedence:

1. `--cmd "..."`
2. `cmd` in `.worktree-preview.json` at the worktree root
3. A `dev` script in `package.json`, run with the package manager its lockfile implies (`pnpm-lock.yaml` gives `pnpm run dev`, `yarn.lock` gives `yarn run dev`, `bun.lock`/`bun.lockb` gives `bun run dev`, otherwise `npm run dev`). Vite ignores `PORT`, so when the script is plain `vite` (or `vite dev`, `vite serve`, with or without flags of its own, but no `--port` and no `&&` or other shell syntax) and the manager is npm, wtp runs `npm run dev -- --port $PORT --strictPort` and says so on stderr. For other tools, or other package managers, use `--cmd`.
4. If the root has an `index.html`, a built-in static file server (correct MIME types, no caching, no directory listings, no path traversal, serves the live files)

If none of these apply, `wtp up` exits 2 and says what to add.

`wtp up` is as trusting as `npm run dev`. It runs whatever the worktree's `.worktree-preview.json` or `package.json` says, with your permissions and no confirmation. Only point it at checkouts you trust.

The command runs through `/bin/sh -c` in the worktree. Its environment has `PORT`, `WTP_PORT` and `WTP_NAME`, plus the variable named by `port_env` if that is not `PORT`. If a tool wants a flag instead, put the variable in the command: `--cmd 'vite --port $PORT'`.

### Dependencies in a fresh worktree

`git worktree add` does not copy `node_modules`, so a new worktree of a Node app cannot start its dev server. When `package.json` declares dependencies and the worktree has no `node_modules` (and no `.pnp.cjs`), `wtp up` says so on stderr before it waits. With `--install`, or `"install": true` in the config, it first runs the install for the lockfile it finds, in the worktree, with the output on stderr:

| Lockfile | Command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --frozen-lockfile`, or `yarn install --immutable` with a `.yarnrc.yml` |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile` |
| `package-lock.json`, `npm-shrinkwrap.json` | `npm ci` |
| none | `npm install` |

It does nothing when `node_modules` exists. A failed install is a failed start: exit 1, nothing registered. Ctrl-C during the install stops it. Tested against real npm, pnpm and yarn 1; the yarn 2+ and bun commands are not tested against the real tools. It installs what the worktree's lockfile says, with your permissions, which is as trusting as `npm run dev`.

### `.worktree-preview.json`

```json
{ "cmd": "npm run dev", "port_env": "PORT", "ready_path": "/", "ready_timeout": 60, "install": false }
```

All keys are optional. Unknown keys are an error, so a typo gets caught.

| Key | Default | Meaning |
| --- | --- | --- |
| `cmd` | detected | Shell command to run |
| `port_env` | `PORT` | Name of the environment variable your server reads its port from |
| `ready_path` | `/` | Path to `GET` when checking readiness |
| `ready_timeout` | `60` | Seconds to wait for readiness (`--wait` overrides it) |
| `install` | `false` | Run the install first when `node_modules` is missing (same as `--install`) |

### Ports

The range is 4100-4199 (override with `WTP_PORT_RANGE=LOW-HIGH`). The starting port comes from a hash of the worktree path, so a worktree gets the same port each time when it is free and different worktrees spread out. If the port is taken, wtp moves forward one at a time, wrapping around the range. `--port N` never moves: if N is in use, `wtp up` exits 1 and starts nothing.

A port is free only if wtp can bind it on every address family and nothing accepts connections on it. wtp checks again just before it spawns the server.

### Readiness

The server is ready when a TCP connection to the port works and `GET ready_path` returns any status below 500. A 404 counts, since something is answering. If the process dies first, `wtp up` fails at once. If `--wait` seconds pass first, it fails with a message pointing at `port_env`, which is nearly always the cause when a dev server ignores `PORT` and listens elsewhere. Either way it stops what it started, prints the last 20 lines of the log on stderr and exits 1.


## State

State lives in `$XDG_STATE_HOME/worktree-preview`, falling back to `~/.local/state/worktree-preview`:

```
previews/<name>.json   one registry entry per preview (written atomically: temp file, then rename)
logs/<name>.log        the preview's stdout and stderr
lock                   held briefly while choosing a port and spawning
```

An entry has `name`, `path`, `branch`, `port`, `pid`, `pgid`, `start_time`, `cmdline`, `cmd`, `started_at`, `log` and `status`. `start_time` is read from `/proc/<pid>/stat` on Linux and `ps -o lstart=` on macOS. The directory and files are private to your user, since command lines can contain secrets.

State stays out of `/tmp` on purpose. A systemd unit with `PrivateTmp=yes` gets its own `/tmp`, so state and logs written there are invisible from your shell. Under the XDG state directory, a preview started from a unit, a terminal or a script is visible to all of them. If you set `XDG_STATE_HOME` only in your shell profile, set the same value for the unit.

`wtp down` removes the preview's log. A preview that died on its own keeps its log until `wtp gc`, so `wtp logs <name>` can still tell you why.

## Environment

| Variable | Meaning |
| --- | --- |
| `XDG_STATE_HOME` | Parent of the state directory (default `~/.local/state`) |
| `WTP_PORT_RANGE` | `LOW-HIGH`, default `4100-4199` |
| `WTP_TERM_GRACE_MS` | Milliseconds between SIGTERM and SIGKILL, default `5000` |
| `BROWSER` | Program `--open` runs with the URL (default `xdg-open` or `open`) |
| `WTP_DEBUG` | Show stack traces for unexpected errors |

