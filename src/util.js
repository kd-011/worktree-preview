import { createHash } from 'node:crypto';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function shq(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

export function hash(s) {
  return createHash('sha1').update(String(s)).digest('hex');
}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

export function defaultName(worktreePath) {
  return slug(path.basename(worktreePath)) || 'preview';
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function table(rows, columns) {
  const cells = [columns.map((c) => c.toUpperCase()), ...rows.map((r) => columns.map((c) => String(r[c] ?? '')))];
  const widths = columns.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  return cells.map((row) => row.map((v, i) => (i === row.length - 1 ? v : v.padEnd(widths[i]))).join('  ')).join('\n');
}
