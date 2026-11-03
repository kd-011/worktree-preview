import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, WtpError } from './errors.js';
import { shq } from './util.js';

export const CONFIG_FILE = '.worktree-preview.json';
const KEYS = ['cmd', 'port_env', 'ready_path', 'ready_timeout', 'install'];

export const STATIC_SERVER = fileURLToPath(new URL('./static-server.js', import.meta.url));

function bad(msg) {
  return new WtpError(`${CONFIG_FILE}: ${msg}`, EXIT.USAGE);
}

export function loadConfig(dir) {
  const out = { cmd: undefined, port_env: 'PORT', ready_path: '/', ready_timeout: undefined, install: false };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw bad(e.message);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw bad(`not valid JSON (${e.message})`);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) throw bad('must be a JSON object');
  for (const k of Object.keys(cfg)) if (!KEYS.includes(k)) throw bad(`unknown key "${k}" (allowed: ${KEYS.join(', ')})`);
  if ('cmd' in cfg) {
    if (typeof cfg.cmd !== 'string' || !cfg.cmd.trim()) throw bad('"cmd" must be a non-empty string');
    out.cmd = cfg.cmd;
  }
  if ('port_env' in cfg) {
    if (typeof cfg.port_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.port_env)) throw bad('"port_env" must be an environment variable name');
    out.port_env = cfg.port_env;
  }
  if ('ready_path' in cfg) {
    if (typeof cfg.ready_path !== 'string' || !cfg.ready_path.startsWith('/')) throw bad('"ready_path" must be a string starting with "/"');
    out.ready_path = cfg.ready_path;
  }
  if ('ready_timeout' in cfg) {
    if (typeof cfg.ready_timeout !== 'number' || !Number.isFinite(cfg.ready_timeout) || cfg.ready_timeout <= 0) throw bad('"ready_timeout" must be a positive number of seconds');
    out.ready_timeout = cfg.ready_timeout;
  }
  if ('install' in cfg) {
    if (typeof cfg.install !== 'boolean') throw bad('"install" must be true or false');
    out.install = cfg.install;
  }
  return out;
}

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm run dev'],
  ['yarn.lock', 'yarn run dev'],
  ['bun.lockb', 'bun run dev'],
  ['bun.lock', 'bun run dev'],
  ['package-lock.json', 'npm run dev'],
];

// Dev servers that ignore $PORT and only take a flag. A script that is exactly
// one of these (plus flags of its own) gets the flag added; anything fancier is
// the author's business and is left alone.
const FLAG_TOOLS = [
  { tool: /^vite(?: dev| serve)?(?= |$)/, flags: '--port $PORT --strictPort', label: 'vite' },
];
const SHELL_SYNTAX = /[&|;<>`$()=]|--port\b|\s-p\b/;

function portFlags(script) {
  const s = script.trim();
  if (SHELL_SYNTAX.test(s)) return null;
  return FLAG_TOOLS.find((t) => t.tool.test(s)) ?? null;
}

/** Work out a command when neither --cmd nor the config file names one. */
export function detectCommand(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof pkg?.scripts?.dev === 'string') {
      const hit = LOCKFILES.find(([f]) => fs.existsSync(path.join(dir, f)));
      const base = hit ? hit[1] : 'npm run dev';
      const preset = base === 'npm run dev' ? portFlags(pkg.scripts.dev) : null;
      if (preset) {
        return {
          cmd: `${base} -- ${preset.flags}`,
          source: 'package.json',
          note: `the dev script is plain ${preset.label}, which ignores $PORT, so wtp adds ${preset.flags}`,
        };
      }
      return { cmd: base, source: 'package.json' };
    }
  } catch {
    // no package.json, or not parseable: fall through
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return { cmd: `${shq(process.execPath)} ${shq(STATIC_SERVER)} .`, source: 'static' };
  }
  return null;
}

/** The command that installs this worktree's dependencies, chosen by lockfile. */
export function installCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('yarn.lock')) return has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  if (has('bun.lockb') || has('bun.lock')) return 'bun install --frozen-lockfile';
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci';
  return 'npm install';
}

/** True when package.json declares dependencies and the worktree has nothing installed. */
export function depsMissing(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).length > 0;
    if (!declared) return false;
  } catch {
    return false;
  }
  return !['node_modules', '.pnp.cjs', '.pnp.js'].some((f) => fs.existsSync(path.join(dir, f)));
}
