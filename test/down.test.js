import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Sandbox, httpGet, isAlive, canBind, waitFor, sleep } from '../test-support/harness.js';
import { readProcess } from '../src/proc.js';

describe('wtp down', { timeout: 180000 }, () => {
  let sb;
  beforeEach(() => {
    sb = new Sandbox({ portBase: 28100 });
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('kills the whole process group, grandchild included, and frees the port', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-fork', 'feature-fork');
    const up = JSON.parse((await sb.up(wt, 'forks.js', ['--json'])).stdout);
    const pids = sb.pids();
    assert.equal(pids.length, 2, 'forks.js records its own pid and its child pid (plus none else)');
    assert.ok(pids.every(isAlive));
    const r = await sb.run(['down', up.name]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pids.filter(isAlive), [], 'every process of the group must be gone when down returns');
    assert.ok(await canBind(up.port), 'port must be released');
    assert.equal(sb.entries().length, 0);
    assert.ok(!fs.existsSync(up.log), 'log of a stopped preview is removed');
  });

  it('escalates to SIGKILL for a server that ignores SIGTERM', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-stubborn', 'feature-stubborn');
    const up = JSON.parse((await sb.up(wt, 'stubborn.js', ['--json'])).stdout);
    const t0 = Date.now();
    const r = await sb.run(['down', up.name], { env: { WTP_TERM_GRACE_MS: '400' } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 300, 'must have waited out the grace period first');
    assert.deepEqual(sb.pids().filter(isAlive), []);
  });

  it('with no argument inside a worktree stops only that worktree', async () => {
    const repo = sb.repo();
    const a = sb.worktree(repo, 'wt-a', 'a');
    const b = sb.worktree(repo, 'wt-b', 'b');
    const ra = JSON.parse((await sb.up(a, 'server.js', ['--json'])).stdout);
    const rb = JSON.parse((await sb.up(b, 'server.js', ['--json'])).stdout);
    const r = await sb.run(['down'], { cwd: a });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!isAlive(ra.pid));
    assert.ok(isAlive(rb.pid));
    assert.equal((await httpGet(rb.url)).status, 200);
    assert.deepEqual(sb.entries().map((e) => e.name), [rb.name]);
  });

  it('accepts a path as well as a name', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-path', 'p');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    const r = await sb.run(['down', wt], { cwd: sb.root });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!isAlive(up.pid));
  });

  it('--all stops every preview and leaves unrelated processes alone', async () => {
    const repo = sb.repo();
    const decoy = sb.decoy();
    const ups = [];
    for (const n of ['x', 'y', 'z']) ups.push(JSON.parse((await sb.up(sb.worktree(repo, `wt-${n}`, n), 'server.js', ['--json'])).stdout));
    const r = await sb.run(['down', '--all']);
    assert.equal(r.code, 0, r.stderr);
    for (const u of ups) {
      assert.ok(!isAlive(u.pid));
      assert.ok(await canBind(u.port));
    }
    assert.ok(isAlive(decoy.pid), 'an unrelated process must survive down --all');
    assert.equal(sb.entries().length, 0);
  });

  it('exits 2 for an unknown name and 0 for a worktree with nothing running', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-none', 'none');
    assert.equal((await sb.run(['down', 'no-such-preview'])).code, 2);
    const r = await sb.run(['down'], { cwd: wt });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /nothing/i);
  });

  it('can stop a preview whose worktree was deleted while it ran', async () => {
    const repo = sb.repo();
    const wt = sb.worktree(repo, 'wt-gone', 'feature-vanish');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    fs.rmSync(wt, { recursive: true, force: true });
    const [entry] = await sb.json(['ls', '--json']);
    assert.equal(entry.name, up.name);
    assert.equal(entry.worktree_missing, true, 'ls must flag the missing worktree');
    assert.equal(entry.branch, 'feature-vanish', 'the recorded branch is kept');
    const r = await sb.run(['down', up.name]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!isAlive(up.pid));
    assert.ok(await canBind(up.port));
  });

  it('reaps group members left behind when the group leader died', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-orphan', 'orphan');
    const up = JSON.parse((await sb.up(wt, 'forks.js', ['--json'])).stdout);
    const pids = sb.pids();
    process.kill(up.pid, 'SIGKILL'); // the exact leader pid wtp reported
    await waitFor(() => !isAlive(up.pid), { what: 'leader to die' });
    assert.ok(pids.filter((p) => p !== up.pid).some(isAlive), 'members survive the leader');
    const r = await sb.run(['down', up.name]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pids.filter(isAlive), []);
    assert.ok(await canBind(up.port));
  });

  describe('never signals a pid it did not start', () => {
    const plantAgainst = async (sb, decoy, overrides) => {
      const info = await readProcess(decoy.pid);
      return sb.plant({
        name: 'planted',
        pid: decoy.pid,
        pgid: decoy.pid,
        start_time: info.startTime,
        cmdline: info.cmdline,
        ...overrides,
      });
    };

    it('a registry entry with a recycled pid (wrong start time) is dropped, the process survives', async () => {
      const decoy = sb.decoy();
      sb.plant({ name: 'planted', pid: decoy.pid, pgid: decoy.pid, start_time: '1', cmdline: '/bin/sh -c old' });
      const r = await sb.run(['down', 'planted']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /not (the process|ours)|recycled|different process/i);
      await sleep(300);
      assert.ok(isAlive(decoy.pid), 'unrelated process was killed');
      assert.equal(sb.entries().length, 0);
    });

    it('right start time but different command line is still not killed', async () => {
      const decoy = sb.decoy();
      await plantAgainst(sb, decoy, { cmdline: '/bin/sh -c something-else' });
      const r = await sb.run(['down', 'planted']);
      assert.equal(r.code, 0, r.stderr);
      await sleep(300);
      assert.ok(isAlive(decoy.pid));
      assert.equal(sb.entries().length, 0);
    });

    it('sanity: the same planted entry with a matching identity IS stopped', async () => {
      const decoy = sb.decoy();
      await plantAgainst(sb, decoy, {});
      const r = await sb.run(['down', 'planted']);
      assert.equal(r.code, 0, r.stderr);
      await waitFor(() => !isAlive(decoy.pid), { what: 'matching entry to be stopped', timeout: 5000 });
    });

    it('down --all, gc, gc --worktrees-gone and ls all leave a recycled pid alone', async () => {
      const decoy = sb.decoy();
      const missing = `${sb.root}/definitely-not-here`;
      for (const args of [['ls'], ['gc'], ['gc', '--worktrees-gone'], ['down', '--all']]) {
        sb.plant({ name: 'planted', path: missing, pid: decoy.pid, pgid: decoy.pid, start_time: '1', cmdline: '/bin/sh -c old' });
        const r = await sb.run(args);
        assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
        await sleep(200);
        assert.ok(isAlive(decoy.pid), `${args.join(' ')} killed an unrelated process`);
        assert.equal(sb.entries().length, 0, `${args.join(' ')} should drop the stale entry`);
      }
    });
  });
});
