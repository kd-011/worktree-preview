import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Sandbox, httpGet, isAlive, canBind, waitFor } from '../test-support/harness.js';

describe('ls, logs, gc, doctor', { timeout: 180000 }, () => {
  let sb;
  beforeEach(() => {
    sb = new Sandbox({ portBase: 28200 });
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('ls prints a table with every column', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-ls', 'feature-ls');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    const r = await sb.run(['ls']);
    assert.equal(r.code, 0, r.stderr);
    const [head, row] = r.stdout.trim().split('\n');
    for (const col of ['NAME', 'BRANCH', 'PORT', 'PID', 'UPTIME', 'URL', 'STATE']) assert.ok(head.includes(col), `missing ${col}`);
    for (const v of [up.name, 'feature-ls', String(up.port), String(up.pid), up.url, 'up']) assert.ok(row.includes(v), `missing ${v} in ${row}`);
  });

  it('ls --json is machine friendly; with nothing running it is []', async () => {
    assert.deepEqual(await sb.json(['ls', '--json']), []);
    const wt = sb.worktree(sb.repo(), 'wt-lsj', 'feature-lsj');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    const [e] = await sb.json(['ls', '--json']);
    assert.equal(e.name, up.name);
    assert.equal(e.state, 'up');
    assert.equal(e.url, up.url);
    assert.equal(e.path, wt);
    assert.equal(typeof e.uptime_seconds, 'number');
  });

  it('ls garbage-collects an entry whose process is gone, and says so', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-dead', 'feature-dead');
    const up = JSON.parse((await sb.up(wt, 'forks.js', ['--json'])).stdout);
    const entry = sb.entries()[0];
    process.kill(-entry.pgid, 'SIGKILL'); // the group wtp itself started
    await waitFor(() => !sb.pids().some(isAlive), { what: 'group to die' });
    const first = await sb.run(['ls', '--json']);
    assert.equal(first.code, 0, first.stderr);
    const list = JSON.parse(first.stdout);
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'dead');
    assert.match(first.stderr, new RegExp(`removed.*${up.name}|${up.name}.*removed`, 's'));
    assert.deepEqual(await sb.json(['ls', '--json']), []);
    assert.equal(sb.entries().length, 0);
  });

  it('logs prints the preview output, by name or by path', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-logs', 'feature-logs');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    for (const target of [up.name, wt]) {
      const r = await sb.run(['logs', target]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes(`listening on ${up.port}`), r.stdout);
    }
  });

  it('logs -f follows new output until stopped', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-follow', 'feature-follow');
    const up = JSON.parse((await sb.up(wt, 'server.js', ['--json'])).stdout);
    const { child, output } = sb.start(['logs', up.name, '-f']);
    await waitFor(() => output().stdout.includes('listening on'), { what: 'initial log' });
    fs.appendFileSync(up.log, 'a brand new line\n');
    await waitFor(() => output().stdout.includes('a brand new line'), { what: 'followed line' });
    child.kill('SIGTERM'); // our own logs process
    await new Promise((r) => child.on('close', r));
  });

  it('gc removes dead entries and orphaned logs but keeps live previews', async () => {
    const repo = sb.repo();
    const live = JSON.parse((await sb.up(sb.worktree(repo, 'wt-live', 'live'), 'server.js', ['--json'])).stdout);
    fs.writeFileSync(path.join(sb.logsDir, 'ghost.log'), 'left over\n');
    const dead = sb.decoy();
    process.kill(dead.pid, 'SIGKILL');
    await new Promise((r) => dead.on('close', r));
    sb.plant({ name: 'corpse', pid: dead.pid, pgid: dead.pid, start_time: '1' });
    const r = await sb.run(['gc']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(sb.logsDir, 'ghost.log')));
    assert.deepEqual(sb.entries().map((e) => e.name), [live.name]);
    assert.ok(fs.existsSync(live.log));
    assert.equal((await httpGet(live.url)).status, 200);
    assert.match(r.stderr + r.stdout, /ghost|orphan/i);
  });

  it('gc --worktrees-gone stops previews whose worktree directory vanished; plain gc does not', async () => {
    const repo = sb.repo();
    const wt = sb.worktree(repo, 'wt-vanish', 'vanish');
    const up = JSON.parse((await sb.up(wt, 'forks.js', ['--json'])).stdout);
    const pids = sb.pids();
    fs.rmSync(wt, { recursive: true, force: true });
    assert.equal((await sb.run(['gc'])).code, 0);
    assert.equal(sb.entries().length, 1, 'plain gc must keep a live preview');
    assert.ok(pids.every(isAlive));
    const r = await sb.run(['gc', '--worktrees-gone']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sb.entries().length, 0);
    assert.deepEqual(pids.filter(isAlive), []);
    assert.ok(await canBind(up.port));
  });

  it('keeps state under XDG_STATE_HOME and falls back to ~/.local/state', async () => {
    const wt = sb.worktree(sb.repo(), 'wt-state', 'state');
    await sb.up(wt, 'server.js');
    assert.ok(fs.existsSync(path.join(sb.stateHome, 'worktree-preview', 'previews')));
    const env = { XDG_STATE_HOME: '' };
    const r = await sb.run(['doctor'], { env });
    assert.ok(r.stdout.includes(path.join(sb.home, '.local', 'state', 'worktree-preview')), r.stdout);
  });

  it('doctor reports git, node, state dir and the port range in plain lines', async () => {
    const r = await sb.run(['doctor']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const word of ['git', 'node', 'state', 'port']) assert.match(r.stdout, new RegExp(word, 'i'));
    assert.match(r.stdout, new RegExp(`${sb.range.lo}-${sb.range.hi}`));
    assert.match(r.stdout, /40\/40|40 of 40/);
    assert.ok(!r.stdout.includes('\u001b['), 'no colour codes');
  });
});
