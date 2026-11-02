---
slug: worktree-preview
name: worktree-preview
repo: .
status: active
last_verified: 2026-11-02
tags: [cli, node, git]
---

`wtp` is a command line tool that serves a git worktree on its own free port, remembers it, and stops exactly what it started. Each claim below is tied to the code that backs it.

## Features

- Runs on Node 22 or newer and has no runtime or development dependencies. <!-- src: package.json -->
- Installs two commands that point at the same script: `wtp` and `worktree-preview`. <!-- src: package.json:8-11 -->
- The command to run is `--cmd`, then `cmd` in the config file, then a detected one, and with none of those `wtp up` exits with a usage error. <!-- src: src/commands/up.js:84-90 -->
- A `dev` script in `package.json` is run with the package manager its lockfile implies, and a root `index.html` falls back to the built-in static server. <!-- src: src/detect.js:50-75 -->
- The config file rejects unknown keys instead of ignoring them. <!-- src: src/detect.js:8, src/detect.js:32 -->
- The default port range is 4100-4199, overridable with `WTP_PORT_RANGE`. <!-- src: src/ports.js:5, src/ports.js:17-19 -->
- The starting port comes from a hash of the worktree path, then moves forward one port at a time and wraps around the range. <!-- src: src/ports.js:25-29 -->
- An explicit `--port` that is taken fails instead of shifting to another port. <!-- src: src/commands/up.js:98-108 -->
- A preview counts as ready when it answers over HTTP with any status below 500, tried on IPv4 loopback first and then IPv6. <!-- src: src/ready.js:9-12, src/ready.js:25 -->

## Architecture

- Stopping a preview sends SIGTERM to its whole process group, then SIGKILL after a grace period that defaults to 5000 ms. <!-- src: src/proc.js:18-22, src/proc.js:150-159 -->
- A signal goes out only if the recorded start time, command line and process group match, or the leader is gone and its group still has members. <!-- src: src/proc.js:117-127, src/proc.js:164-167 -->
- The static server refuses `..` segments, `.git` paths and symlinks that lead outside the served tree. <!-- src: src/static-server.js:68-83 -->
- State is kept under the XDG state directory with owner-only permissions, because recorded command lines can hold secrets. <!-- src: src/state.js:11-15, src/state.js:27-28, src/state.js:70 -->
- Exit codes are 0 for success, 1 for failure, 2 for usage errors and 3 when the path is not a git worktree. <!-- src: src/errors.js:1 -->

## Deploy

- CI runs `node --test` on Linux and macOS for every pull request and once a week. <!-- src: .github/workflows/ci.yml:3-11, .github/workflows/ci.yml:24 -->

<!-- auto:start -->
- package: worktree-preview 0.1.0
- npm scripts (1): test
<!-- auto:end -->
