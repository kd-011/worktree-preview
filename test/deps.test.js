import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Sandbox, httpGet, nodeCmd, waitFor } from '../test-support/harness.js';
import { detectCommand, depsMissing, installCommand, loadConfig } from '../src/detect.js';

const realNpm = execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();

describe('dev servers that ignore PORT', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-preset-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = (dev) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { dev } }));

  it('hands the port to a plain vite dev script as a flag', () => {
    pkg('vite');
    const d = detectCommand(dir);
    assert.equal(d.cmd, 'npm run dev -- --port $PORT --strictPort');
    assert.equal(d.source, 'package.json');
    assert.match(d.note, /vite/);
    assert.match(d.note, /--port/);
  });

  it('keeps the flags the script already has and adds ours after them', () => {
    pkg('vite --host');
    assert.equal(detectCommand(dir).cmd, 'npm run dev -- --port $PORT --strictPort');
  });

  it('leaves a script alone when it already names a port, chains commands, or runs another tool', () => {
    for (const dev of ['vite --port 3000', 'vite -p 3000', 'vite --port=3000', 'vite build && vite preview', 'next dev', 'node server.js', 'vite; echo hi', 'PORT=1 vite']) {
      pkg(dev);
      const d = detectCommand(dir);
      assert.equal(d.cmd, 'npm run dev', dev);
      assert.equal(d.note, undefined, dev);
    }
  });

  it('serves a vite-style tool that only listens where it is told with --port', async () => {
    const sb = new Sandbox({ portBase: 28400 });
    try {
      const wt = sb.worktree(sb.repo(), 'wt-vite', 'vite');
      sb.write(wt, 'package.json', JSON.stringify({ name: 'v', scripts: { dev: 'vite' } }));
      sb.write(wt, 'package-lock.json', '{}');
      sb.write(
        wt,
        'node_modules/.bin/vite',
        `#!/usr/bin/env node
const i = process.argv.indexOf('--port');
if (i < 0) { console.error('no --port given'); process.exit(1); }
if (!process.argv.includes('--strictPort')) process.exit(1);
if (process.env.WTP_TEST_PIDS) require('node:fs').writeFileSync(require('node:path').join(process.env.WTP_TEST_PIDS, String(process.pid)), '');
require('node:http').createServer((q, r) => r.end('vite ok')).listen(Number(process.argv[i + 1]));
`,
      );
      fs.chmodSync(path.join(wt, 'node_modules/.bin/vite'), 0o755);
      const r = await sb.run(['up'], { cwd: wt });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /vite/);
      assert.equal((await httpGet(r.stdout.trim())).body, 'vite ok');
    } finally {
      await sb.cleanup();
    }
  });
});

describe('installing dependencies', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-install-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (f, c = '') => fs.writeFileSync(path.join(dir, f), c);

  it('picks the install command from the lockfile', () => {
    const cases = [
      [null, 'npm install'],
      ['package-lock.json', 'npm ci'],
      ['npm-shrinkwrap.json', 'npm ci'],
      ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
      ['yarn.lock', 'yarn install --frozen-lockfile'],
      ['bun.lockb', 'bun install --frozen-lockfile'],
      ['bun.lock', 'bun install --frozen-lockfile'],
    ];
    for (const [lock, cmd] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      put('package.json', '{}');
      if (lock) put(lock);
      assert.equal(installCommand(dir), cmd, String(lock));
    }
    put('yarn.lock');
    put('.yarnrc.yml');
    assert.equal(installCommand(dir), 'yarn install --immutable');
  });

  it('says dependencies are missing only when package.json declares some and nothing is installed', () => {
    assert.equal(depsMissing(dir), false, 'no package.json');
    put('package.json', JSON.stringify({ scripts: { dev: 'x' } }));
    assert.equal(depsMissing(dir), false, 'no dependencies declared');
    put('package.json', JSON.stringify({ devDependencies: { next: '16' } }));
    assert.equal(depsMissing(dir), true);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    assert.equal(depsMissing(dir), false, 'node_modules exists');
    fs.rmdirSync(path.join(dir, 'node_modules'));
    put('.pnp.cjs');
    assert.equal(depsMissing(dir), false, 'yarn plug and play has no node_modules');
  });

  it('accepts "install": true in the config and rejects anything else', () => {
    put('.worktree-preview.json', '{"install": true}');
    assert.equal(loadConfig(dir).install, true);
    assert.equal(loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-none-'))).install, false);
    put('.worktree-preview.json', '{"install": "yes"}');
    assert.throws(() => loadConfig(dir), /"install" must be true or false/);
  });
});

describe('wtp up and missing dependencies', { timeout: 120000 }, () => {
  let sb;
  let shim;
  let npmLog;
  beforeEach(() => {
    sb = new Sandbox({ portBase: 28500 });
    shim = path.join(sb.root, 'shim');
    npmLog = path.join(sb.root, 'npm.log');
    fs.mkdirSync(shim);
    // A stand-in for npm: records what it was asked, fakes `ci` and `install`, passes everything else to the real one.
    fs.writeFileSync(
      path.join(shim, 'npm'),
      `#!/bin/sh
echo "$PWD: $*" >> "$FAKE_NPM_LOG"
case "$1" in
  ci|install)
    if [ -n "$FAKE_NPM_SLEEP" ]; then echo $$ > "$WTP_TEST_PIDS/$$"; exec sleep "$FAKE_NPM_SLEEP"; fi
    if [ -n "$FAKE_NPM_DELAY" ]; then sleep "$FAKE_NPM_DELAY"; fi
    if [ -n "$FAKE_NPM_EXIT" ]; then echo "npm ERR! boom" >&2; exit "$FAKE_NPM_EXIT"; fi
    mkdir -p node_modules ;;
  *) exec "$FAKE_NPM_REAL" "$@" ;;
esac
`,
    );
    fs.chmodSync(path.join(shim, 'npm'), 0o755);
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const env = (extra = {}) => ({
    PATH: `${shim}${path.delimiter}${process.env.PATH}`,
    FAKE_NPM_LOG: npmLog,
    FAKE_NPM_REAL: realNpm,
    ...extra,
  });
  const npmCalls = () => (fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').trim().split('\n') : []);

  function app(name) {
    const wt = sb.worktree(sb.repo(), name, name);
    sb.write(wt, 'package.json', JSON.stringify({ name, scripts: { dev: `node ${path.join(import.meta.dirname, '../test-support/fixtures/server.js')}` }, dependencies: { left: '1.0.0' } }));
    sb.write(wt, 'package-lock.json', '{}');
    return wt;
  }

  it('warns before it waits when the worktree has no node_modules', async () => {
    const wt = app('wt-warn');
    const r = await sb.run(['up'], { cwd: wt, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /no node_modules/);
    assert.match(r.stderr, /npm ci/);
    assert.match(r.stderr, /--install/);
    assert.deepEqual(npmCalls().filter((l) => /: (ci|install)/.test(l)), [], 'must not install unasked');
  });

  it('does not warn when a custom non-node command is given', async () => {
    const wt = app('wt-quiet');
    const r = await sb.up(wt, 'server.js', [], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /node_modules/);
  });

  it('--install runs the lockfile install in the worktree, then starts the server', async () => {
    const wt = app('wt-install');
    const r = await sb.run(['up', '--install', '--json'], { cwd: wt, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).path, wt, 'stdout stays one JSON object');
    assert.ok(fs.existsSync(path.join(wt, 'node_modules')));
    assert.deepEqual(npmCalls().filter((l) => !/run dev/.test(l)), [`${wt}: ci`]);
    assert.match(r.stderr, /running: npm ci/);
    assert.doesNotMatch(r.stderr, /If the server fails/);
  });

  it('the wait for readiness starts after the install, so a slow install does not use it up', async () => {
    const wt = app('wt-slow');
    const r = await sb.run(['up', '--install', '--wait', '2'], { cwd: wt, env: env({ FAKE_NPM_DELAY: '3' }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await httpGet(r.stdout.trim())).status, 200);
  });

  it('"install": true in the config does the same', async () => {
    const wt = app('wt-cfg');
    sb.write(wt, '.worktree-preview.json', '{"install": true}');
    const r = await sb.run(['up'], { cwd: wt, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(wt, 'node_modules')));
  });

  it('--install does nothing when node_modules already exists', async () => {
    const wt = app('wt-have');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    const r = await sb.run(['up', '--install'], { cwd: wt, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(npmCalls().filter((l) => !/run dev/.test(l)), []);
  });

  it('a failed install is a failed start: exit 1, the reason on stderr, nothing left behind', async () => {
    const wt = app('wt-fail');
    const r = await sb.run(['up', '--install'], { cwd: wt, env: env({ FAKE_NPM_EXIT: '3' }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /npm ci/);
    assert.match(r.stderr, /exited with code 3/);
    assert.match(r.stderr, /boom/, 'install output reaches the user');
    assert.equal(sb.entries().length, 0);
    assert.equal(r.stdout, '');
    await sb.assertClean();
  });

  it('Ctrl-C during the install stops the install and starts nothing', async () => {
    const wt = app('wt-int');
    const { child, done } = sb.start(['up', '--install'], { cwd: wt, env: env({ FAKE_NPM_SLEEP: '30' }) });
    await waitFor(() => sb.pids().length === 1, { what: 'install to start' });
    child.kill('SIGINT');
    const r = await done;
    assert.equal(r.code, 130, r.stderr);
    assert.equal(sb.entries().length, 0);
    await sb.assertClean();
  });
});
