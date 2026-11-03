import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../test-support/harness.js';

const script = path.join(ROOT, 'scripts', 'release.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } });
const plan = (version, published, releaseExists, hasToken = true) =>
  run(['plan', '--version', version, '--published', published, '--release-exists', String(releaseExists), '--has-token', String(hasToken)]);

describe('release plan', () => {
  it('publishes and releases a version above everything on npm', () => {
    const j = JSON.parse(plan('0.3.0', '0.1.0,0.2.0', false).stdout);
    assert.equal(j.publish, true);
    assert.equal(j.release, true);
  });

  it('does nothing for a version that is already published and released', () => {
    const j = JSON.parse(plan('0.2.0', '0.1.0,0.2.0', true).stdout);
    assert.equal(j.publish, false);
    assert.equal(j.release, false);
  });

  it('finishes the release when npm has the version but there is no GitHub Release', () => {
    const j = JSON.parse(plan('0.2.0', '0.2.0', false).stdout);
    assert.equal(j.publish, false);
    assert.equal(j.release, true);
  });

  it('refuses an unpublished version older than the newest on npm, and compares numbers not strings', () => {
    assert.equal(plan('0.1.5', '0.1.0,0.2.0', false).status, 1);
    assert.equal(JSON.parse(plan('0.10.0', '0.9.0', false).stdout).publish, true);
  });

  it('refuses anything but x.y.z', () => {
    for (const v of ['1.0', '1.0.0-rc.1', 'v1.0.0', '']) assert.equal(plan(v, '0.1.0', false).status, 1, v);
  });

  it('first publish without a token is skipped, with a reason, and the release still goes ahead', () => {
    const j = JSON.parse(plan('0.2.0', '', false, false).stdout);
    assert.equal(j.publish, false);
    assert.equal(j.release, true);
    assert.match(j.reason, /NPM_TOKEN/);
  });

  it('first publish with a token publishes', () => {
    assert.equal(JSON.parse(plan('0.2.0', '', false, true).stdout).publish, true);
  });

  it('once the package exists on npm a missing token falls through to trusted publishing', () => {
    assert.equal(JSON.parse(plan('0.3.0', '0.2.0', false, false).stdout).publish, true);
  });

  it('writes its answer to GITHUB_OUTPUT, including npm_skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-release-'));
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    const r = run(['plan', '--version', '0.2.0', '--published', '', '--release-exists', 'false', '--has-token', 'false'], { GITHUB_OUTPUT: out });
    const text = fs.readFileSync(out, 'utf8');
    fs.rmSync(dir, { recursive: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(text, /^publish=false$/m);
    assert.match(text, /^release=true$/m);
    assert.match(text, /^npm_skipped=true$/m);
  });
});

describe('release notes and the publish workflow', () => {
  const CHANGELOG = '# Changelog\n\n## Unreleased\n\n## [0.3.0] - 2026-12-01\n\n### Added\n- the thing\n\n## [0.2.0] - 2026-11-02\n\n- old\n';
  const notes = (version, text = CHANGELOG) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-notes-'));
    const file = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(file, text);
    const r = run(['notes', version, '--changelog', file]);
    fs.rmSync(dir, { recursive: true });
    return r;
  };

  it('prints the body of one version section only', () => {
    const r = notes('0.3.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '### Added\n- the thing');
  });

  it('fails when the section is missing or empty', () => {
    assert.equal(notes('9.9.9').status, 1);
    assert.equal(notes('0.3.0', '## [0.3.0]\n\n## [0.2.0]\n- x\n').status, 1);
  });

  it("the repository's own changelog has a section for the current version", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const r = run(['notes', version]);
    assert.equal(r.status, 0, r.stderr);
  });

  it('publish.yml runs on push to main for package.json and by hand, and never reads the token into output', () => {
    const y = fs.readFileSync(path.join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    assert.match(y, /^\s+workflow_dispatch:/m);
    assert.match(y, /paths: \[package\.json\]/);
    assert.match(y, /HAS_NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN != '' \}\}/);
    assert.doesNotMatch(y, /echo[^\n]*NPM_TOKEN\}?"?\s*$/m);
    assert.match(y, /npm publish --provenance --access public --ignore-scripts/);
  });
});
