import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox, httpGet, nodeCmd, waitFor, sleep } from '../test-support/harness.js';

describe('interruption, survival and races', { timeout: 180000 }, () => {
  let sb;
  beforeEach(() => {
    sb = new Sandbox({ portBase: 28300 });
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    it(`${signal} while waiting for readiness tears down what up started`, async () => {
      const wt = sb.worktree(sb.repo(), 'wt-int', 'int');
      const { child, done } = sb.start(['up', '--wait', '60', '--cmd', nodeCmd('ignores-port.js')], { cwd: wt });
      await waitFor(() => sb.entries().length === 1 && sb.pids().length === 1, { what: 'preview to be registered' });
      child.kill(signal); // the exact wtp up process we started
      const r = await done;
      assert.equal(r.code, code, r.stderr);
      assert.equal(sb.entries().length, 0);
      await sb.assertClean();
    });
  }

  it('the preview survives the shell that launched it going away', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-survive', 'survive');
    const { child, done } = sb.start(['up', '--json', '--cmd', nodeCmd('server.js')], { cwd: wt, detached: true });
    const r = await done;
    assert.equal(r.code, 0, r.stderr);
    const up = JSON.parse(r.stdout);
    for (const sig of ['SIGHUP', 'SIGTERM']) {
      try {
        process.kill(-child.pid, sig); // the launcher's whole group, as a closing terminal would
      } catch {}
    }
    await sleep(500);
    assert.equal((await httpGet(up.url)).status, 200);
    assert.equal((await sb.run(['down', up.name])).code, 0);
  });

  it('two simultaneous ups on one explicit port: exactly one wins, the loser spawns nothing', async () => {
    const repo = sb.repo();
    const a = sb.worktree(repo, 'wt-ra', 'ra');
    const b = sb.worktree(repo, 'wt-rb', 'rb');
    const port = String(sb.range.lo + 11);
    const [ra, rb] = await Promise.all([
      sb.up(a, 'server.js', ['--port', port]),
      sb.up(b, 'server.js', ['--port', port]),
    ]);
    assert.deepEqual([ra.code, rb.code].sort(), [0, 1], `${ra.stderr} | ${rb.stderr}`);
    const loser = ra.code === 1 ? ra : rb;
    assert.match(loser.stderr, /in use|already/i);
    assert.equal(sb.entries().length, 1);
    assert.equal(sb.pids().length, 1, 'the loser must not have started a process');
    assert.equal((await httpGet(`http://localhost:${port}/`)).status, 200);
  });

  it('two simultaneous ups for the same worktree share one preview', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-same', 'same');
    const slow = ['--json', '--cmd', `FIXTURE_DELAY_MS=800 ${nodeCmd('server.js')}`];
    const [x, y] = await Promise.all([sb.run(['up', ...slow], { cwd: wt }), sb.run(['up', ...slow], { cwd: wt })]);
    assert.equal(x.code, 0, x.stderr);
    assert.equal(y.code, 0, y.stderr);
    assert.equal(JSON.parse(x.stdout).pid, JSON.parse(y.stdout).pid);
    assert.equal(sb.entries().length, 1);
    assert.equal(sb.pids().length, 1);
  });

  it('six simultaneous ups on six worktrees all get distinct ports', async () => {
    const repo = sb.repo();
    const wts = [1, 2, 3, 4, 5, 6].map((n) => sb.worktree(repo, `wt-many-${n}`, `many-${n}`));
    const results = await Promise.all(wts.map((wt) => sb.up(wt, 'server.js', ['--json'])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const ports = results.map((r) => JSON.parse(r.stdout).port);
    assert.equal(new Set(ports).size, 6, ports.join(','));
    for (const r of results) assert.equal((await httpGet(JSON.parse(r.stdout).url)).status, 200);
  });
});
