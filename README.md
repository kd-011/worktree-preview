# worktree-preview

[![ci](https://github.com/kd-011/worktree-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/kd-011/worktree-preview/actions/workflows/ci.yml)

`wtp` serves a git worktree on its own free port with one command, remembers it, and stops it again. It only ever kills processes it started. It is for people who keep several worktrees alive at once (one per feature branch, and lately one per coding agent) and want them running side by side without port clashes, forgotten dev servers or half-dead process trees.

Node 22, zero npm dependencies, Linux and macOS. Windows is not supported (WSL works).

![wtp up, ls and down --all on two git worktrees](docs/screenshots/terminal.png)

## 30-second demo

```console
$ git worktree add ../app-login -b login
$ git worktree add ../app-billing -b billing

$ wtp up ../app-login
http://localhost:4197
$ wtp up ../app-billing
http://localhost:4183

$ wtp ls
NAME         BRANCH   PORT  PID      UPTIME  URL                    STATE
app-login    login    4197  2803591  12s     http://localhost:4197  up
app-billing  billing  4183  2803615  9s      http://localhost:4183  up

$ wtp up ../app-login          # idempotent: same URL, nothing new started
http://localhost:4197

$ wtp down --all
stopped app-login
stopped app-billing
```

`wtp up` prints the URL on stdout once the server answers. The server runs in the worktree itself, so the next request sees whatever you just saved.

## Install

Clone the repository and link it:

```sh
npm link        # provides `wtp` and `worktree-preview`
```

Or run `node bin/wtp.js` directly. `wtp doctor` checks your setup.

## Commands

| Command | What it does |
| --- | --- |
| `wtp up [path] [--port N] [--cmd "..."] [--name X] [--wait 60] [--open] [--json]` | Start the preview for a worktree (default: the current directory) and print its URL. If one is already running and healthy, print its URL and exit 0. |
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
3. A `dev` script in `package.json`, run with the package manager its lockfile implies (`pnpm-lock.yaml` gives `pnpm run dev`, `yarn.lock` gives `yarn run dev`, `bun.lock`/`bun.lockb` gives `bun run dev`, otherwise `npm run dev`)
4. If the root has an `index.html`, a built-in static file server (correct MIME types, no caching, no directory listings, no path traversal, serves the live files)

If none of these apply, `wtp up` exits 2 and says what to add.

`wtp up` is as trusting as `npm run dev`. It runs whatever the worktree's `.worktree-preview.json` or `package.json` says, with your permissions and no confirmation. Only point it at checkouts you trust.

The command runs through `/bin/sh -c` in the worktree. Its environment has `PORT`, `WTP_PORT` and `WTP_NAME`, plus the variable named by `port_env` if that is not `PORT`. If a tool wants a flag instead, put the variable in the command: `--cmd 'vite --port $PORT'`.

### `.worktree-preview.json`

```json
{ "cmd": "npm run dev", "port_env": "PORT", "ready_path": "/", "ready_timeout": 60 }
```

All keys are optional. Unknown keys are an error, so a typo gets caught.

| Key | Default | Meaning |
| --- | --- | --- |
| `cmd` | detected | Shell command to run |
| `port_env` | `PORT` | Name of the environment variable your server reads its port from |
| `ready_path` | `/` | Path to `GET` when checking readiness |
| `ready_timeout` | `60` | Seconds to wait for readiness (`--wait` overrides it) |

### Ports

The range is 4100-4199 (override with `WTP_PORT_RANGE=LOW-HIGH`). The starting port comes from a hash of the worktree path, so a worktree gets the same port each time when it is free and different worktrees spread out. If the port is taken, wtp moves forward one at a time, wrapping around the range. `--port N` never moves: if N is in use, `wtp up` exits 1 and starts nothing.

A port is free only if wtp can bind it on every address family and nothing accepts connections on it. wtp checks again just before it spawns the server.

### Readiness

The server is ready when a TCP connection to the port works and `GET ready_path` returns any status below 500. A 404 counts, since something is answering. If the process dies first, `wtp up` fails at once. If `--wait` seconds pass first, it fails with a message pointing at `port_env`, which is nearly always the cause when a dev server ignores `PORT` and listens elsewhere. Either way it stops what it started, prints the last 20 lines of the log on stderr and exits 1.

## Promises

Each guarantee and the test behind it. `node --test` runs them all against real git worktrees and real servers.

| Promise | Test |
| --- | --- |
| The server runs in the live worktree, never a copy: edit a file and the next request sees it. | `up.test.js`: serves the live tree; static server variant |
| The preview outlives `wtp up` and the shell that ran it. `wtp down` is the normal way it ends. | `interrupt.test.js`: survives the shell |
| If `wtp up` is interrupted (Ctrl-C, SIGTERM) before the server is ready, everything it started is stopped. | `interrupt.test.js`: SIGINT / SIGTERM |
| A start that fails (crash, ignored `PORT`, 5xx, timeout) leaves no process, no registry entry and no held port. | `up.test.js`: ignores PORT, crash at start, non-5xx |
| `wtp down` signals the whole process group (SIGTERM, then SIGKILL after 5 seconds), so grandchildren are reaped and the port is released. | `down.test.js`: whole group, SIGKILL escalation |
| `wtp` never signals a pid it did not start. Before any signal, the registered pid must still match the registered start time, command line and process group. A recycled pid is dropped from the registry and left alone. | `down.test.js`: never signals a pid it did not start |
| Nothing kills by name. There is no `pkill`, `killall` or process-name match anywhere, and the only `process.kill` call is the group helper. | `source-guards.test.js` |
| Two `wtp up` racing for one port cannot both win; racing for one worktree they share a single server. | `interrupt.test.js`: races |
| An explicit `--port` that is taken fails clearly and never shifts. | `up.test.js` |
| If the group leader dies and leaves children behind, `down`, `gc` and `ls` still find and reap them. | `down.test.js`: reaps group members left behind |
| The static server refuses anything that resolves outside the tree, in every encoding, and symlinks that escape it. | `static.test.js` |
| The tests themselves leak nothing: every test is followed by a teardown that fails the test if a process, registry entry or port of its own remains. | `test-support/harness.js` |

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

### Running under systemd

`examples/systemd/wtp@.service` is a user unit that ties a preview to the unit's lifetime:

```sh
cp examples/systemd/wtp@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start "wtp@$(systemd-escape --path /path/to/worktree).service"
systemctl --user stop  "wtp@$(systemd-escape --path /path/to/worktree).service"
```

`wtp up` exits once the server is ready, and the server keeps running in the unit's cgroup (`RemainAfterExit=yes`). Stopping the unit runs `wtp down`, and systemd sweeps whatever is left in the cgroup. I tried it with a transient unit that had `PrivateTmp=yes`: the preview was visible from a normal shell, and stopping the unit left no process behind. The unit does not restart anything. If the server crashes, run `wtp up` again.

## AI agents

Give each agent its own worktree and preview, and you can watch every branch running at once:

```sh
# one worktree and one preview per agent task
for task in login billing search; do
  git worktree add -b "agent/$task" "../app-$task"
  wtp up "../app-$task" --json >> previews.jsonl || echo "agent/$task failed to start" >&2
done

# every running preview, ready for a script or a dashboard
wtp ls --json | jq -r '.[] | select(.state == "up") | "\(.branch)\t\(.url)"'

# when an agent is done
wtp down ../app-login && git worktree remove ../app-login

# end of the day: stop all previews, and clear out any whose worktree is gone
wtp down --all
wtp gc --worktrees-gone
```

For unattended use:

- `wtp up` is idempotent, so an agent can call it every time without checking first.
- A preview survives the agent's shell exiting. `wtp ls` lists every one and `wtp down --all` stops every one, so nothing gets orphaned.
- When the server will not start, `wtp up` exits 1 with the log tail on stderr. A failed start is a failed command, not a hang.
- Pass `--wait` for slow builds, or set `ready_timeout` in the config so every agent gets the same value.

## Limits

- Linux and macOS only. The macOS code path (`ps` instead of `/proc`) is covered by the CI matrix. I don't use it daily.
- Previews live on `localhost` and are registered per user. There is no web UI, daemon, tunnel, reverse proxy or subdomain routing.
- The command must stay in the foreground. One that backgrounds the real server and exits (`server &`) looks like a dead process, and `wtp up` fails.
- Readiness is an HTTP check, so a server that does not speak HTTP never becomes ready.
- wtp can only reap what stays in the process group it created. A server that escapes it (`setsid`, double fork) is not covered. `down` warns if the port is still held afterwards and leaves the escapee alone.
- A command that `exec`s a different program changes the command line wtp recorded. wtp refreshes the record when the server becomes ready, so this works. A `down` in the first moments of a start may decline to stop it and tell you why.
- Another process could take the port in the short gap between the port check and the server binding it. The readiness check then fails or sees the other process, and `wtp up` reports it.
- The static server is for plain HTML. Don't use it in production.

## Environment

| Variable | Meaning |
| --- | --- |
| `XDG_STATE_HOME` | Parent of the state directory (default `~/.local/state`) |
| `WTP_PORT_RANGE` | `LOW-HIGH`, default `4100-4199` |
| `WTP_TERM_GRACE_MS` | Milliseconds between SIGTERM and SIGKILL, default `5000` |
| `BROWSER` | Program `--open` runs with the URL (default `xdg-open` or `open`) |
| `WTP_DEBUG` | Show stack traces for unexpected errors |

## Licence

MIT, copyright (c) 2026 kd-011. See `LICENSE`.

## Contributing

See `CONTRIBUTING.md`. Sign off your commits (DCO), there is no CLA, and add a test that fails without your change.
