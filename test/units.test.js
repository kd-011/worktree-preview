import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portCandidates, parseRange, DEFAULT_RANGE } from '../src/ports.js';
import { detectCommand, loadConfig } from '../src/detect.js';

describe('ports', () => {
  it('defaults to 4100-4199', () => {
    assert.deepEqual(DEFAULT_RANGE, { lo: 4100, hi: 4199 });
    assert.deepEqual(parseRange('4100-4199'), { lo: 4100, hi: 4199 });
  });

  it('rejects bad ranges', () => {
    for (const bad of ['', 'abc', '5000-4000', '0-10', '4100', '4100-70000']) assert.throws(() => parseRange(bad), /range/i, bad);
  });

  it('is deterministic, stays in range and covers every port exactly once', () => {
    const range = { lo: 5000, hi: 5049 };
    const a = portCandidates('/some/worktree', range);
    assert.deepEqual(a, portCandidates('/some/worktree', range));
    assert.equal(a.length, 50);
    assert.equal(new Set(a).size, 50);
    assert.ok(a.every((p) => p >= 5000 && p <= 5049));
    a.forEach((p, i) => assert.equal(p, 5000 + ((a[0] - 5000 + i) % 50), 'falls forward one port at a time, wrapping'));
  });

  it('spreads different paths across the range', () => {
    const range = { lo: 5000, hi: 5099 };
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => portCandidates(`/work/tree-${i}`, range)[0]));
    assert.ok(firsts.size > 20, `only ${firsts.size} distinct preferred ports out of 40 paths`);
  });
});

describe('command detection', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-detect-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (f, c = '') => fs.writeFileSync(path.join(dir, f), c);
  const pkg = (scripts) => put('package.json', JSON.stringify({ name: 'x', scripts }));

  it('uses the package manager implied by the lockfile for the dev script', () => {
    const cases = [
      [null, 'npm run dev'],
      ['package-lock.json', 'npm run dev'],
      ['pnpm-lock.yaml', 'pnpm run dev'],
      ['yarn.lock', 'yarn run dev'],
      ['bun.lockb', 'bun run dev'],
      ['bun.lock', 'bun run dev'],
    ];
    for (const [lock, cmd] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      pkg({ dev: 'node server.js' });
      if (lock) put(lock);
      assert.deepEqual(detectCommand(dir), { cmd, source: 'package.json' }, String(lock));
    }
  });

  it('prefers the dev script over index.html', () => {
    pkg({ dev: 'vite' });
    put('index.html', '<p/>');
    assert.equal(detectCommand(dir).source, 'package.json');
  });

  it('falls back to the static server when there is index.html but no dev script', () => {
    pkg({ build: 'x' });
    put('index.html', '<p/>');
    const d = detectCommand(dir);
    assert.equal(d.source, 'static');
    assert.match(d.cmd, /static-server\.js/);
  });

  it('returns null when there is nothing to run', () => {
    assert.equal(detectCommand(dir), null);
    pkg({ build: 'x' });
    assert.equal(detectCommand(dir), null);
  });
});

describe('config file', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-config-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is optional and has sensible defaults', () => {
    assert.deepEqual(loadConfig(dir), { cmd: undefined, port_env: 'PORT', ready_path: '/', ready_timeout: undefined, install: false });
  });

  it('reads all five keys', () => {
    fs.writeFileSync(path.join(dir, '.worktree-preview.json'), JSON.stringify({ cmd: 'x', port_env: 'P', ready_path: '/h', ready_timeout: 9, install: true }));
    assert.deepEqual(loadConfig(dir), { cmd: 'x', port_env: 'P', ready_path: '/h', ready_timeout: 9, install: true });
  });

  it('rejects wrong types and unknown keys with a config error', () => {
    for (const bad of [{ cmd: 3 }, { port_env: 'not valid!' }, { ready_path: 'no-slash' }, { ready_timeout: -1 }, { surprise: 1 }]) {
      fs.writeFileSync(path.join(dir, '.worktree-preview.json'), JSON.stringify(bad));
      assert.throws(() => loadConfig(dir), (e) => e.exitCode === 2, JSON.stringify(bad));
    }
  });
});
