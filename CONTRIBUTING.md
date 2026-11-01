# Contributing

Bug reports, fixes and small features are welcome.

## Ground rules

- Zero runtime dependencies. If a change needs one, it is probably the wrong change.
- Node 22, ES modules, `node:test`. Linux and macOS only.
- Keep the safety guarantees in the README true. A change that touches
  `src/proc.js` (identity checks, signalling) or `src/static-server.js` (path
  handling) needs a test that fails without the change.
- Never add a name-based kill (`pkill`, `killall`, matching on process names).
  `test/source-guards.test.js` fails if one appears.

## Running the tests

```sh
node --test                    # whole suite
node --test test/down.test.js  # one file
```

The tests create real git repositories and worktrees in a temporary directory,
start real servers on ports 28000-28399, and fail if any test leaves a process,
a registry entry or a held port behind. Each test file uses its own port block,
so files can run in parallel.

## Sign-off (DCO), no CLA

There is no contributor licence agreement. Instead, every commit must carry a
`Signed-off-by` line, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote
the change or have the right to submit it under the project's MIT licence.

```sh
git commit -s -m "Describe the change"
```

## Pull requests

- One logical change per pull request, with tests.
- Say what you ran. For macOS-specific changes, say whether you could test on a Mac.
- Commit messages in plain English; no trailers other than `Signed-off-by`.
