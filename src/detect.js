import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, WtpError } from './errors.js';
import { shq } from './util.js';

export const CONFIG_FILE = '.worktree-preview.json';
const KEYS = ['cmd', 'port_env', 'ready_path', 'ready_timeout'];

export const STATIC_SERVER = fileURLToPath(new URL('./static-server.js', import.meta.url));

function bad(msg) {
  return new WtpError(`${CONFIG_FILE}: ${msg}`, EXIT.USAGE);
}

export function loadConfig(dir) {
  const out = { cmd: undefined, port_env: 'PORT', ready_path: '/', ready_timeout: undefined };
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
  return out;
}

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm run dev'],
  ['yarn.lock', 'yarn run dev'],
  ['bun.lockb', 'bun run dev'],
  ['bun.lock', 'bun run dev'],
  ['package-lock.json', 'npm run dev'],
];

/** Work out a command when neither --cmd nor the config file names one. */
export function detectCommand(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof pkg?.scripts?.dev === 'string') {
      const hit = LOCKFILES.find(([f]) => fs.existsSync(path.join(dir, f)));
      return { cmd: hit ? hit[1] : 'npm run dev', source: 'package.json' };
    }
  } catch {
    // no package.json, or not parseable: fall through
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return { cmd: `${shq(process.execPath)} ${shq(STATIC_SERVER)} .`, source: 'static' };
  }
  return null;
}
