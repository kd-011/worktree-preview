---
slug: worktree-preview-agents
name: worktree-preview agent guide
repo: .
status: active
last_verified: 2026-11-22
---

# worktree-preview: guide for coding agents

The doc index is docs/README.md. Read docs/ARCHITECTURE.md before changing structure. What the tool is for and how to use it is in README.md.

## Commands

- Run every test with `npm test`, which is `node --test`. <!-- src: package.json:46-48 -->
- Run one test file while iterating: `node --test test/down.test.js`. <!-- src: CONTRIBUTING.md:17-20 -->
- Run the CLI from a checkout with `node bin/wtp.js <command>`. The installed names are `wtp` and `worktree-preview`. <!-- src: package.json:8-11, bin/wtp.js:1-9 -->
- There is nothing to install, build, lint, format or typecheck: the package has no dependencies and its only script is `test`. <!-- src: package.json:46-48, test/source-guards.test.js:27-36 -->
- CI runs `node --test` on Node 22 on Linux and macOS, on every pull request, on pushes to main and once a week. <!-- src: .github/workflows/ci.yml:3-11, .github/workflows/ci.yml:24-35 -->
- Redraw the README terminal image from a real run with `node scripts/render-demo.mjs`, or print the transcript with `--text`. Rendering needs a headless Chromium. <!-- src: scripts/render-demo.mjs:1-9 -->
- Release by adding a `## [x.y.z]` section to CHANGELOG.md and raising the version in `package.json`. A merge to main that changes `package.json` runs `publish.yml`. <!-- src: .github/workflows/publish.yml:1-6, .github/workflows/publish.yml:14-18 -->
- The self dossier and the pinned docs are checked with dossier-scribe: run `dossier-scribe lint`, then `check`, then `pin --all`, and commit the docs and `dossiers/.dossier-lock.json`. The weekly upkeep job runs the same checks. <!-- src: dossier-scribe.json, .github/workflows/upkeep.yml:68-72 -->

## Conventions

- ES modules, Node 22 or newer, Node built-ins only. A test fails if `package.json` gains `dependencies` or `devDependencies`, or a source file imports anything but `node:` modules and relative paths. <!-- src: package.json:5, package.json:18-20, test/source-guards.test.js:27-36 -->
- One module per command in `src/commands/`, loaded with a dynamic `import` from the `switch` in `src/cli.js`, and each flag is declared in the `SPECS` table there. <!-- src: src/cli.js:37-44, src/cli.js:88-128 -->
- Fail with a `WtpError` carrying an `EXIT` code. `run` in `src/cli.js` prints `wtp: <message>` to stderr and returns the code. <!-- src: src/errors.js:1-10, src/cli.js:131-142 -->
- Messages for people go to stderr, so stdout stays the URL, the JSON object or the table and is safe to parse. <!-- src: src/commands/up.js:38-40, src/commands/up.js:220-230, src/install.js:5-11 -->
- A change to `src/proc.js` (identity checks, signalling) or `src/static-server.js` (path handling) needs a test that fails without it. <!-- src: CONTRIBUTING.md:9-11 -->
- Every commit carries a DCO sign-off (`git commit -s`). There is no CLA. Commit messages are plain English with no trailers other than `Signed-off-by`. <!-- src: CONTRIBUTING.md:27-42 -->
- One logical change per pull request, with tests. <!-- src: CONTRIBUTING.md:40 -->
- Third-party actions are pinned by full SHA, every workflow declares top-level `permissions`, and no workflow expands PR or issue text into a shell line. Tests enforce all three. <!-- src: test/kit.test.js:35-59 -->
- The Dependabot config stays on GitHub Actions only, weekly, with a seven-day cooldown, because the repo has no npm dependencies to update. <!-- src: test/kit.test.js:15-23 -->
- The files the maintenance kit added carry no em dash, no home path and no personal email. <!-- src: test/kit.test.js:155-167 -->

## Traps

- Nothing may signal a process except `signalGroup` in `src/proc.js`: a test counts `process.kill(` calls and wants exactly one in `src/proc.js` and none elsewhere in `src/` or `bin/`. It also fails on `pkill`, `killall`, `pgrep` and `kill -`. <!-- src: test/source-guards.test.js:11-25, src/proc.js:128-137 -->
- A registry entry authorises a signal only while its pid still has the recorded start time, command line and process group. Call `checkIdentity` or `stopEntry` before signalling, never `killGroup` on a pgid read from an entry. <!-- src: src/proc.js:1-5, src/proc.js:115-126, src/proc.js:162-168 -->
- Process facts come from `/proc` on Linux and from `ps` on macOS, in two code paths. A change to one needs the other kept in step, and CI is the only macOS coverage. <!-- src: src/proc.js:13-14, src/proc.js:22-66, src/proc.js:68-102 -->
- The command is run as `<cmd>` then `exit $?` through `/bin/sh -c`. The trailing `exit` stops the shell exec-ing a single command, which would change the process identity wtp recorded. <!-- src: src/commands/up.js:121-125 -->
- State lives under `$XDG_STATE_HOME/worktree-preview`, never in `/tmp`, so a systemd unit with `PrivateTmp` sees the same files as a shell. <!-- src: src/state.js:1-3, src/state.js:11-15 -->
- `git` and `ps` are run with `LC_ALL=C`, because their output is parsed. <!-- src: src/git.js:10, src/proc.js:14 -->
- A preview is ready when `GET ready_path` answers below 500 on IPv4 loopback, else IPv6. A server that does not speak HTTP never becomes ready, and a command that backgrounds the real server looks dead. <!-- src: src/ready.js:1-25 -->
- Each test file owns a block of 40 ports: 28000 (`up`), 28100 (`down`), 28200 (`gc`), 28300 (`interrupt`), 28400 and 28500 (`deps`). A new test file needs a block of its own. CONTRIBUTING.md says 28000-28399, which is out of date. <!-- src: test-support/harness.js:104-111, test/up.test.js:11, test/down.test.js:10, test/gc.test.js:10, test/interrupt.test.js:8, test/deps.test.js:44, test/deps.test.js:128, CONTRIBUTING.md:22-25 -->
- Every test ends with a teardown that fails the test if it left a process, a registry entry or a held port. Leaked state in a new test shows up as a failure in that test, not a later one. <!-- src: docs/guarantees.md:22, CONTRIBUTING.md:22-25 -->
- `test/kit.test.js` pins the self dossier: it must hold 5 to 15 cited claims, each in the lock, so adding a claim to `dossiers/worktree-preview.md` means checking that count. It also needs a CHANGELOG heading for the version in `package.json`. <!-- src: test/kit.test.js:120-129, test/kit.test.js:138-153 -->
- The ruleset on main requires the two CI job names `node --test (ubuntu-latest, node 22)` and `node --test (macos-latest, node 22)`. Renaming the job or the matrix breaks the required check, and a test compares them. <!-- src: .github/rulesets/main.json:17-20, test/kit.test.js:92-106 -->
- The weekly upkeep job installs dossier-scribe from the `v0.1.0` tag. That release predates the `path#key` citation form, so cite files and line ranges in the pinned docs here, as `package.json:46-48`. <!-- src: .github/workflows/upkeep.yml:62-63 -->
- A cited file must be committed before `lint` or `pin`, because dossier-scribe reads `HEAD`. <!-- src: dossier-scribe.json -->

## Unverified

- That dossier-scribe v0.1.0 cannot read `path#key` citations. It is taken from that tool's own changelog for 0.2.0, not from anything in this repo.
- Behaviour on macOS beyond what CI covers, and the yarn 2+ and bun install commands against the real tools: the README says neither has been run by hand.

## Generated facts

<!-- auto:start -->
- package: worktree-preview 0.2.0
- npm scripts (1): test
<!-- auto:end -->
