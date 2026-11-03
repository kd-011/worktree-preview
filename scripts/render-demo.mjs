#!/usr/bin/env node
// Renders docs/screenshots/terminal.png from a real run: it builds a small app in a temp directory, makes two
// worktrees of it, runs the real `wtp` against them and draws what the commands printed. Nothing is typed in by
// hand, so the ports and the table are whatever this machine produced.
//
//   node scripts/render-demo.mjs [--out docs/screenshots/terminal.png] [--text]
//
// --text prints the transcript instead of rendering it (no browser needed). Rendering needs a headless Chromium:
// set CHROME_BIN, or have chromium, google-chrome or brave-browser on PATH. Fonts: Fira Mono or JetBrains Mono, then
// the system monospace.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WTP = join(root, 'bin', 'wtp.js');
const args = process.argv.slice(2);
const textOnly = args.includes('--text');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'docs', 'screenshots', 'terminal.png');

const work = mkdtempSync(join(tmpdir(), 'wtp-demo-'));
const env = {
  ...process.env,
  XDG_STATE_HOME: join(work, 'state'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'demo',
  GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'demo',
  GIT_COMMITTER_EMAIL: 'demo@example.invalid',
};
const sh = (cmd, cwd) => spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' });

// A plain Node app: it reads PORT and shows the branch's title.txt.
const app = join(work, 'app');
mkdirSync(app);
git(app, 'init', '-q', '-b', 'main');
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { dev: 'node server.js' } }, null, 2));
writeFileSync(
  join(app, 'server.js'),
  `import http from 'node:http';
import fs from 'node:fs';
http.createServer((req, res) => res.end(fs.readFileSync('title.txt', 'utf8'))).listen(process.env.PORT);
`,
);
writeFileSync(join(app, 'title.txt'), 'main\n');
git(app, 'add', '.');
git(app, 'commit', '-q', '-m', 'init');
for (const b of ['login', 'billing']) {
  git(app, 'worktree', 'add', '-q', '-b', b, join(work, `app-${b}`));
  writeFileSync(join(work, `app-${b}`, 'title.txt'), `the ${b} branch\n`);
}

const lines = [];
const wtp = (a) => `node ${WTP} ${a}`;
function step(shown, cmd) {
  lines.push({ kind: 'cmd', text: `$ ${shown}` });
  const r = sh(cmd, app);
  for (const l of `${r.stdout}${r.stderr}`.replace(/\n$/, '').split('\n')) if (l !== '') lines.push({ kind: shown.startsWith('curl') ? 'out' : /^http:/.test(l) ? 'url' : 'out', text: l });
  return r;
}

try {
  step('wtp up ../app-login', wtp('up ../app-login'));
  step('wtp up ../app-billing', wtp('up ../app-billing'));
  const ls = JSON.parse(sh(wtp('ls --json'), app).stdout);
  const urlOf = (n) => ls.find((e) => e.name === n).url;
  lines.push({ kind: 'gap' });
  step(`curl -s ${urlOf('app-login')}`, `curl -s ${urlOf('app-login')}`);
  step(`curl -s ${urlOf('app-billing')}`, `curl -s ${urlOf('app-billing')}`);
  lines.push({ kind: 'gap' });
  step('wtp ls', wtp('ls'));
  lines.push({ kind: 'gap' });
  step('wtp down --all', wtp('down --all'));
} finally {
  sh(wtp('down --all'), app);
  rmSync(work, { recursive: true, force: true });
}

const plain = lines.map((l) => (l.kind === 'gap' ? '' : l.text));
if (textOnly) {
  process.stdout.write(`${plain.join('\n')}\n`);
  process.exit(0);
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'brave-browser']) {
    for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error('no headless Chromium found. Set CHROME_BIN.');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rows = lines.map((l) => (l.kind === 'gap' ? '<div class="row">&nbsp;</div>' : `<div class="row ${l.kind}">${esc(l.text)}</div>`)).join('\n');
const longest = Math.max(...plain.map((l) => l.length));
const fontPx = 20;
const width = Math.max(900, Math.ceil(longest * fontPx * 0.6) + 96);
const height = Math.ceil(plain.length * fontPx * 1.6) + 150;
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0d1117}
body{width:${width}px;height:${height}px;box-sizing:border-box;padding:28px 40px;font:${fontPx}px/1.6 "Fira Mono","JetBrains Mono","DejaVu Sans Mono",monospace;color:#e6edf3}
.dots{display:flex;gap:12px;margin-bottom:26px}.dots i{width:18px;height:18px;border-radius:50%;display:block}
.cmd{color:#7ee787}.url{color:#ff9f5a}.row{white-space:pre}
</style><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
${rows}`;

const dir = mkdtempSync(join(tmpdir(), 'wtp-render-'));
const page = join(dir, 'terminal.html');
writeFileSync(page, html);
mkdirSync(dirname(out), { recursive: true });
try {
  execFileSync(findChrome(), ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, `--screenshot=${out}`, `file://${page}`], { stdio: 'ignore' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`wrote ${out}\n`);
