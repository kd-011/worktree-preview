# Changelog

All notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- Weekly Dependabot updates for GitHub Actions, grouped by minor and patch with a seven-day cooldown, and auto-merge once the required checks pass.
- A weekly upkeep workflow that checks README links and the project's own dossier, and opens one issue per problem.
- A dossier for this repository with a committed lock file.
- Security policy, code of conduct, issue and pull request templates.

### Changed

- CI also runs once a week, so the badge reflects the current state of `main`.

## 0.1.0

First release.

- `wtp up`, `ls`, `logs`, `down`, `gc` and `doctor`.
- One free port per worktree from a path hash, with a readiness check before the URL is printed.
- Teardown signals only the process group `wtp` started, after checking the recorded pid, start time and command line.
- Built-in static server for plain HTML, with path traversal and symlink escapes refused.
- Node 22, no runtime dependencies, Linux and macOS.
