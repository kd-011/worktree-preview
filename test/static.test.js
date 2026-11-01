import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { httpGet, rawGet } from '../test-support/harness.js';
import { createStaticServer } from '../src/static-server.js';

describe('built-in static server', { timeout: 60000 }, () => {
  let dir, site, server, port;
  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtp-static-')));
    site = path.join(dir, 'site');
    fs.mkdirSync(path.join(site, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(site, '.git'));
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP SECRET');
    fs.writeFileSync(path.join(site, '.git', 'config'), 'git internals');
    fs.writeFileSync(path.join(site, 'index.html'), '<p>home</p>');
    fs.writeFileSync(path.join(site, 'sub', 'index.html'), '<p>sub</p>');
    fs.writeFileSync(path.join(site, 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(site, 'style.css'), 'a{}');
    fs.writeFileSync(path.join(site, 'data.json'), '{}');
    fs.writeFileSync(path.join(site, 'logo.svg'), '<svg/>');
    fs.writeFileSync(path.join(site, 'pic.png'), Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(path.join(site, 'mod.wasm'), Buffer.from([0, 97, 115, 109]));
    fs.writeFileSync(path.join(site, 'unknown.zzz'), 'bytes');
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(site, 'escape.txt'));
    server = createStaticServer(site);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const url = (p) => `http://127.0.0.1:${port}${p}`;

  it('serves files with correct MIME types', async () => {
    const want = {
      '/': 'text/html',
      '/index.html': 'text/html',
      '/sub/': 'text/html',
      '/app.js': 'text/javascript',
      '/style.css': 'text/css',
      '/data.json': 'application/json',
      '/logo.svg': 'image/svg+xml',
      '/pic.png': 'image/png',
      '/mod.wasm': 'application/wasm',
      '/unknown.zzz': 'application/octet-stream',
    };
    for (const [p, type] of Object.entries(want)) {
      const r = await httpGet(url(p));
      assert.equal(r.status, 200, p);
      assert.ok(r.headers['content-type'].startsWith(type), `${p}: ${r.headers['content-type']}`);
    }
  });

  it('never caches, so edits show immediately', async () => {
    assert.match((await httpGet(url('/'))).headers['cache-control'], /no-store|no-cache/);
    fs.writeFileSync(path.join(site, 'index.html'), '<p>changed</p>');
    assert.equal((await httpGet(url('/'))).body, '<p>changed</p>');
  });

  it('404s missing files and gives no directory listing', async () => {
    assert.equal((await httpGet(url('/nope.txt'))).status, 404);
    fs.rmSync(path.join(site, 'sub', 'index.html'));
    assert.equal((await httpGet(url('/sub/'))).status, 404);
  });

  it('blocks path traversal in every encoding', async () => {
    const attempts = [
      '/../secret.txt',
      '/../../secret.txt',
      '/sub/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%2fsecret.txt',
      '/%252e%252e/secret.txt',
      '/..\\secret.txt',
      '/sub/..%5c..%5csecret.txt',
      '/%00/../secret.txt',
      '/escape.txt',
    ];
    for (const p of attempts) {
      const r = await rawGet(port, p);
      assert.ok(!r.body.includes('TOP SECRET'), `${p} leaked the file (status ${r.status})`);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  });

  it('does not serve .git', async () => {
    const r = await rawGet(port, '/.git/config');
    assert.ok(!r.body.includes('git internals'));
    assert.ok([403, 404].includes(r.status));
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(url('/'), { method: 'POST', agent: false }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res, 405);
  });
});
