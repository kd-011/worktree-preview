# Changelog

Changes are listed newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## Unreleased

## [0.2.0] - 2026-11-03

### Added

- `wtp up --install`, and `"install": true` in `.worktree-preview.json`. A new worktree has no `node_modules`, so its dev server could not start. With the option, `wtp` runs the install for the lockfile it finds (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`) in the worktree first, with the output on stderr. It does nothing when `node_modules` exists. A failed install exits 1 and starts nothing, and Ctrl-C stops it.
- Without the option, `wtp up` now says on stderr when a worktree declares dependencies and has no `node_modules`, instead of waiting out the timeout with a message about `PORT`.
- A dev script that is plain `vite` now runs as `npm run dev -- --port $PORT --strictPort`, because Vite ignores `PORT`. `wtp` says so on stderr. Scripts that already name a port, chain commands or run another tool are left alone.
- `scripts/render-demo.mjs` draws the README image from a real run. The reference, agent and guarantee text moved to `docs/`, and the README now covers install, a first run, alternatives and when not to use it.
- `publish.yml` and `scripts/release.mjs` publish to npm with provenance and make the GitHub Release when `package.json` gets a new version. Until the package is on npm and an `NPM_TOKEN` secret exists, the npm step is skipped with a notice and the GitHub Release is still made.
- `package.json` carries `repository`, `homepage` and `bugs`.

### Changed

- Weekly Dependabot updates for GitHub Actions, grouped by minor and patch, with a seven-day cooldown. They auto-merge once the required checks pass.
- A weekly upkeep workflow that checks the README links and the project's dossier. It opens one issue per problem.
- CI also runs once a week, so the badge shows the current state of `main`.
- A dossier for this repository, with a committed lock file, a security policy, a code of conduct, and issue and pull request templates.

## [0.1.0]

First release.

- `wtp up`, `ls`, `logs`, `down`, `gc` and `doctor`.
- One free port per worktree from a path hash, with a readiness check before the URL is printed.
- Teardown signals only the process group `wtp` started, after checking the recorded pid, start time and command line.
- Built-in static server for plain HTML, with path traversal and symlink escapes refused.
- Node 22, no runtime dependencies, Linux and macOS.
