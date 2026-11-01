import net from 'node:net';
import { WtpError, EXIT } from './errors.js';
import { hash } from './util.js';

export const DEFAULT_RANGE = { lo: 4100, hi: 4199 };

export function parseRange(str) {
  const m = /^(\d+)-(\d+)$/.exec(String(str ?? '').trim());
  const lo = m && Number(m[1]);
  const hi = m && Number(m[2]);
  if (!m || lo < 1024 || hi > 65535 || lo > hi) {
    throw new WtpError(`invalid port range ${JSON.stringify(str)}: expected LOW-HIGH within 1024-65535, for example 4100-4199`, EXIT.USAGE);
  }
  return { lo, hi };
}

export function rangeFromEnv(env = process.env) {
  return env.WTP_PORT_RANGE ? parseRange(env.WTP_PORT_RANGE) : DEFAULT_RANGE;
}

/**
 * Every port of the range, in the order to try them for this worktree: a start
 * point derived from the path hash, then forward one at a time, wrapping.
 */
export function portCandidates(worktreePath, range = DEFAULT_RANGE) {
  const size = range.hi - range.lo + 1;
  const start = parseInt(hash(worktreePath).slice(0, 8), 16) % size;
  return Array.from({ length: size }, (_, i) => range.lo + ((start + i) % size));
}

function tryListen(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL' ? 'unsupported' : false));
    s.listen({ port, host }, () => s.close(() => resolve(true)));
  });
}

/** Does anything accept connections on the port, on either loopback family? */
export function isListening(port, timeoutMs = 400) {
  const attempt = (host) =>
    new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  return Promise.all([attempt('127.0.0.1'), attempt('::1')]).then(([a, b]) => a || b);
}

/**
 * Free means: we can bind it on every address family and nothing is listening.
 * Binding alone is not enough on BSD-derived systems, where a wildcard bind can
 * succeed next to a loopback listener.
 */
export async function isBindable(port) {
  for (const host of ['0.0.0.0', '::', '127.0.0.1', '::1']) {
    if ((await tryListen(port, host)) === false) return false;
  }
  return !(await isListening(port));
}
