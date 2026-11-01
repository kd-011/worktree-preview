import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Sandbox, httpGet, nodeCmd, waitFor, canBind, isAlive } from '../test-support/harness.js';
import { portCandidates } from '../src/ports.js';

describe('wtp up', { timeout: 180000 }, () => {
  let sb;
  beforeEach(() => {
    sb = new Sandbox({ portBase: 28000 });
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('starts the server and prints only the URL, which answers', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-a', 'feature-a');
    const r = await sb.up(wt, 'server.js');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^http:\/\/localhost:\d+\n$/);
    const res = await httpGet(r.stdout.trim());
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(`cwd=${wt}\n`), res.body);
  });

  it('serves the live tree: an edit shows up at once and nothing is copied', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-live', 'feature-live');
    sb.write(wt, 'marker.txt', 'version-one');
    const r = await sb.up(wt, 'server.js');
    assert.equal(r.code, 0, r.stderr);
    const url = r.stdout.trim();
    assert.ok((await httpGet(url)).body.includes('marker=version-one'));
    sb.write(wt, 'marker.txt', 'version-two');
    const after = await httpGet(url);
    assert.ok(after.body.includes('marker=version-two'), after.body);
    assert.ok(after.body.includes(`cwd=${wt}\n`), 'server must run inside the worktree itself');
    // Nothing under the state dir may contain a copy of the tree.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    assert.ok(!walk(sb.stateDir).includes('marker.txt'));
  });

  it('is idempotent: a second up returns the same URL and pid, exit 0', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-idem', 'feature-idem');
    const a = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    const second = await sb.up(wt, 'server.js', ['--json']);
    assert.equal(second.code, 0, second.stderr);
    const b = JSON.parse(second.stdout);
    assert.equal(b.url, a.url);
    assert.equal(b.pid, a.pid);
    assert.equal(sb.entries().length, 1);
    assert.equal(sb.pids().length, 1, 'only one server process may ever have been started');
  });

  it('picks a deterministic port from the worktree path and reuses it', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-det', 'feature-det');
    const expected = portCandidates(wt, sb.range)[0];
    const a = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    assert.equal(a.port, expected);
    assert.equal((await sb.run(['down'], { cwd: wt })).code, 0);
    const b = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    assert.equal(b.port, expected);
  });

  it('falls forward when the preferred port is taken, even by a loopback-only listener', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-clash', 'feature-clash');
    const [first, second] = portCandidates(wt, sb.range);
    await sb.blocker(first, '127.0.0.1');
    const r = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    assert.equal(r.port, second);
  });

  it('fails clearly, without shifting, when an explicit --port is in use', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-explicit', 'feature-explicit');
    const port = sb.range.lo + 7;
    await sb.blocker(port);
    const r = await sb.up(wt, 'server.js', ['--port', String(port)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`${port}`));
    assert.match(r.stderr, /in use/i);
    assert.equal(sb.entries().length, 0);
    assert.equal(sb.pids().length, 0, 'nothing may be spawned for a port that is taken');
  });

  it('honours a free explicit --port', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-port', 'feature-port');
    const port = sb.range.lo + 9;
    const r = JSON.parse((await sb.up(wt, 'server.js', ['--port', String(port), '--json'])).stdout);
    assert.equal(r.port, port);
    assert.equal((await httpGet(`http://localhost:${port}/`)).status, 200);
  });

  it('runs two worktrees of one repo on different ports, each serving its own tree', async () => {
    const repo = sb.repo();
    const a = sb.worktree(repo, 'wt-one', 'branch-one');
    const b = sb.worktree(repo, 'wt-two', 'branch-two');
    const ra = JSON.parse((await sb.up(a, 'server.js', ['--json'])).stdout);
    const rb = JSON.parse((await sb.up(b, 'server.js', ['--json'])).stdout);
    assert.notEqual(ra.port, rb.port);
    assert.notEqual(ra.name, rb.name);
    assert.ok((await httpGet(ra.url)).body.includes(`cwd=${a}\n`));
    assert.ok((await httpGet(rb.url)).body.includes(`cwd=${b}\n`));
    const ls = await sb.json(['ls', '--json']);
    assert.deepEqual(ls.map((e) => e.branch).sort(), ['branch-one', 'branch-two']);
  });

  it('works for the main checkout too', async () => {
    const repo = sb.repo();
    const r = await sb.up(repo, 'server.js');
    assert.equal(r.code, 0, r.stderr);
  });

  it('handles paths with spaces', async () => {
    const wt = sb.worktree(sb.repo(), 'my worktree dir', 'feature-space');
    sb.write(wt, 'marker.txt', 'spaced');
    const r = await sb.up(wt, 'server.js');
    assert.equal(r.code, 0, r.stderr);
    assert.ok((await httpGet(r.stdout.trim())).body.includes(`cwd=${wt}\n`));
    assert.equal((await sb.run(['down', wt])).code, 0);
    await sb.assertClean();
  });

  it('handles a detached HEAD', async () => {
    const repo = sb.repo();
    const wt = sb.worktree(repo, 'wt-detached', 'feature-detached');
    sb.git(wt, 'checkout', '-q', '--detach');
    const r = await sb.up(wt, 'server.js');
    assert.equal(r.code, 0, r.stderr);
    const [entry] = await sb.json(['ls', '--json']);
    assert.match(entry.branch, /^\(detached [0-9a-f]{7,}\)$/);
  });

  it('accepts a path argument and a subdirectory of the worktree', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-arg', 'feature-arg');
    sb.write(wt, 'sub/x.txt', 'x');
    const r = await sb.run(['up', path.join(wt, 'sub'), '--cmd', nodeCmd('server.js')], { cwd: sb.root });
    assert.equal(r.code, 0, r.stderr);
    assert.ok((await httpGet(r.stdout.trim())).body.includes(`cwd=${wt}\n`), 'cwd must be the worktree root');
  });

  it('waits for a slow server and only then prints the URL', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-slow', 'feature-slow');
    const t0 = Date.now();
    const r = await sb.run(['up', '--cmd', `FIXTURE_DELAY_MS=1500 ${nodeCmd('server.js')}`], { cwd: wt });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 1400);
    assert.equal((await httpGet(r.stdout.trim())).status, 200);
  });

  it('treats any non-5xx answer as ready, and 5xx as not ready', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-404', 'feature-404');
    const ok = await sb.run(['up', '--cmd', `FIXTURE_ROOT_STATUS=404 ${nodeCmd('server.js')}`], { cwd: wt });
    assert.equal(ok.code, 0, ok.stderr);
    await sb.run(['down'], { cwd: wt });
    const bad = await sb.run(['up', '--wait', '2', '--cmd', `FIXTURE_ROOT_STATUS=503 ${nodeCmd('server.js')}`], { cwd: wt });
    assert.equal(bad.code, 1);
    await sb.assertClean();
  });

  it('passes PORT, WTP_PORT and WTP_NAME to the server', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-env', 'feature-env');
    const r = JSON.parse((await sb.up(wt, 'server.js', ['--name', 'envcheck', '--json'])).stdout);
    const env = JSON.parse((await httpGet(`${r.url}/env`)).body);
    assert.deepEqual(env, { PORT: String(r.port), WTP_PORT: String(r.port), WTP_NAME: 'envcheck' });
    assert.equal(r.name, 'envcheck');
  });

  it('prints a stable JSON object with --json', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-json', 'feature-json');
    const r = await sb.up(wt, 'server.js', ['--json']);
    const o = JSON.parse(r.stdout);
    for (const k of ['url', 'port', 'pid', 'name', 'log']) assert.ok(k in o, `missing ${k}`);
    assert.equal(typeof o.port, 'number');
    assert.equal(typeof o.pid, 'number');
    assert.ok(isAlive(o.pid));
    assert.ok(fs.existsSync(o.log));
  });

  it('reports a server that ignores PORT, pointing at port_env, and cleans up', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-ignore', 'feature-ignore');
    const t0 = Date.now();
    const r = await sb.up(wt, 'ignores-port.js', ['--wait', '2']);
    assert.equal(r.code, 1);
    assert.ok(Date.now() - t0 < 20000);
    assert.match(r.stderr, /port_env/);
    assert.match(r.stderr, /PORT/);
    assert.equal(sb.entries().length, 0);
    await sb.assertClean();
  });

  it('shows the last 20 log lines when the server dies at start', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-crash', 'feature-crash');
    const t0 = Date.now();
    const r = await sb.run(['up', '--wait', '30', '--cmd', `FIXTURE_NOISE=50 ${nodeCmd('crashes.js')}`], { cwd: wt });
    assert.equal(r.code, 1);
    assert.ok(Date.now() - t0 < 15000, 'a dead process must fail fast, not wait out --wait');
    assert.match(r.stderr, /boom: simulated crash/);
    const noise = r.stderr.split('\n').filter((l) => /^noise \d+$/.test(l));
    assert.equal(noise.length, 19);
    assert.equal(noise.at(-1), 'noise 50');
    assert.equal(sb.entries().length, 0);
    await sb.assertClean();
  });

  describe('command selection', () => {
    it('reads .worktree-preview.json: cmd, port_env, ready_path', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-cfg', 'feature-cfg');
      sb.write(
        wt,
        '.worktree-preview.json',
        JSON.stringify({
          cmd: `FIXTURE_PORT_VAR=MY_PORT FIXTURE_ROOT_STATUS=503 ${nodeCmd('server.js')}`,
          port_env: 'MY_PORT',
          ready_path: '/health',
          ready_timeout: 20,
        }),
      );
      const r = JSON.parse((await sb.run(['up', '--json'], { cwd: wt })).stdout);
      const body = (await httpGet(`${r.url}/`)).body;
      assert.equal((await httpGet(`${r.url}/health`)).status, 200);
      assert.equal((await httpGet(`${r.url}/`)).status, 503);
      assert.ok(body.includes('port_var=MY_PORT'));
    });

    it('lets --cmd win over the config file', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-win', 'feature-win');
      sb.write(wt, '.worktree-preview.json', JSON.stringify({ cmd: nodeCmd('crashes.js') }));
      const r = await sb.up(wt, 'server.js');
      assert.equal(r.code, 0, r.stderr);
    });

    it('honours ready_timeout from the config', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-rt', 'feature-rt');
      sb.write(wt, '.worktree-preview.json', JSON.stringify({ cmd: nodeCmd('ignores-port.js'), ready_timeout: 2 }));
      const t0 = Date.now();
      const r = await sb.run(['up'], { cwd: wt });
      assert.equal(r.code, 1);
      assert.ok(Date.now() - t0 < 20000);
    });

    it('serves a directory with index.html using the built-in static server, live', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-static', 'feature-static');
      sb.write(wt, 'index.html', '<h1>one</h1>');
      const r = await sb.run(['up'], { cwd: wt });
      assert.equal(r.code, 0, r.stderr);
      const url = r.stdout.trim();
      const res = await httpGet(url);
      assert.equal(res.body, '<h1>one</h1>');
      assert.match(res.headers['content-type'], /^text\/html/);
      sb.write(wt, 'index.html', '<h1>two</h1>');
      assert.equal((await httpGet(url)).body, '<h1>two</h1>');
    });

    it('fails with exit 2 when there is nothing to run', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-empty', 'feature-empty');
      const r = await sb.run(['up'], { cwd: wt });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--cmd/);
    });

    it('fails with exit 2 on a broken config file', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-badcfg', 'feature-badcfg');
      sb.write(wt, '.worktree-preview.json', '{ not json');
      const r = await sb.run(['up'], { cwd: wt });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /worktree-preview\.json/);
    });
  });

  describe('exit codes', () => {
    it('3 outside a git worktree', async () => {
      const plain = path.join(sb.root, 'plain');
      fs.mkdirSync(plain);
      const r = await sb.up(plain, 'server.js');
      assert.equal(r.code, 3);
      assert.match(r.stderr, /git/i);
    });

    it('2 for unknown flags, bad ports, bad names and unknown commands', async () => {
      const wt = sb.worktree(sb.repo(), 'wt-usage', 'feature-usage');
      for (const args of [['up', '--nope'], ['up', '--port', 'abc'], ['up', '--port', '99999'], ['up', '--name', 'Bad Name!'], ['frobnicate']]) {
        const r = await sb.run(args, { cwd: wt });
        assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code}`);
      }
    });

    it('2 when a name is already used by another worktree', async () => {
      const repo = sb.repo();
      const a = sb.worktree(repo, 'wt-n1', 'n1');
      const b = sb.worktree(repo, 'wt-n2', 'n2');
      assert.equal((await sb.up(a, 'server.js', ['--name', 'same'])).code, 0);
      const r = await sb.up(b, 'server.js', ['--name', 'same']);
      assert.equal(r.code, 2);
    });
  });

  it('opens the URL through $BROWSER with --open', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-open', 'feature-open');
    const out = path.join(sb.root, 'opened.txt');
    const script = path.join(sb.root, 'fake-browser.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho "$1" > "${out}"\n`, { mode: 0o755 });
    const r = await sb.run(['up', '--open', '--cmd', nodeCmd('server.js')], { cwd: wt, env: { BROWSER: script } });
    assert.equal(r.code, 0, r.stderr);
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim(), { what: 'browser launch' });
    assert.equal(fs.readFileSync(out, 'utf8').trim(), r.stdout.trim());
  });

  it('leaves no temp files in the registry after writes', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-atomic', 'feature-atomic');
    await sb.up(wt, 'server.js');
    const files = fs.readdirSync(sb.previewsDir);
    assert.deepEqual(files.filter((f) => !f.endsWith('.json')), []);
    const entry = sb.entries()[0];
    for (const k of ['name', 'path', 'branch', 'port', 'pid', 'pgid', 'start_time', 'cmd', 'started_at', 'log']) {
      assert.ok(k in entry, `entry missing ${k}`);
    }
    assert.ok(await canBind(sb.range.hi), 'sanity: unrelated port still free');
  });
});
