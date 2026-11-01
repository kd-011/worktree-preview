import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../test-support/harness.js';

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))].map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]);

describe('source guards', () => {
  it('has no name-based killing anywhere', () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /\bpkill\b|\bkillall\b|\bpgrep\b|\bkill\s+-/, file);
    }
  });

  it('signals processes only through the group helper in proc.js', () => {
    for (const [file, text] of sources) {
      const calls = text.match(/process\.kill\(/g) ?? [];
      assert.equal(calls.length, file === path.join('src', 'proc.js') ? 1 : 0, `${file} calls process.kill ${calls.length} times`);
    }
    const proc = sources.find(([f]) => f.endsWith('proc.js'))[1];
    assert.match(proc, /process\.kill\(-pgid, sig\)/);
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/from '([^']+)'/g)) {
        assert.ok(m[1].startsWith('node:') || m[1].startsWith('.'), `${file} imports ${m[1]}`);
      }
    }
  });
});
