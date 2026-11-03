# Guarantees and limits

What `wtp` promises, the test behind each promise, and what it does not cover.

`node --test` runs them all against real git worktrees and real servers.

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
| `--install` runs only when `node_modules` is missing, writes its output to stderr, and a failed or interrupted install starts nothing and leaves nothing behind. | `deps.test.js` |
| A plain `vite` dev script gets `--port $PORT --strictPort`; a script that already names a port, or chains commands, is left alone. | `deps.test.js` |
| The static server refuses anything that resolves outside the tree, in every encoding, and symlinks that escape it. | `static.test.js` |
| The tests themselves leak nothing: every test is followed by a teardown that fails the test if a process, registry entry or port of its own remains. | `test-support/harness.js` |


## Limits

- Linux and macOS only. The macOS code path (`ps` instead of `/proc`) is covered by the CI matrix. I don't use it daily.
- Previews live on `localhost` and are registered per user. There is no web UI, daemon, tunnel, reverse proxy or subdomain routing.
- The command must stay in the foreground. One that backgrounds the real server and exits (`server &`) looks like a dead process, and `wtp up` fails.
- Readiness is an HTTP check, so a server that does not speak HTTP never becomes ready.
- wtp can only reap what stays in the process group it created. A server that escapes it (`setsid`, double fork) is not covered. `down` warns if the port is still held afterwards and leaves the escapee alone.
- A command that `exec`s a different program changes the command line wtp recorded. wtp refreshes the record when the server becomes ready, so this works. A `down` in the first moments of a start may decline to stop it and tell you why.
- Another process could take the port in the short gap between the port check and the server binding it. The readiness check then fails or sees the other process, and `wtp up` reports it.
- The static server is for plain HTML. Don't use it in production.

