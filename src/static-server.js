// Built-in static file server for worktrees that are just HTML. No dependencies.
// Reads from disk on every request (the live tree, never a copy) and refuses
// anything that resolves outside the root.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
};

function reply(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${status} ${text}\n`);
}

function inside(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

export function createStaticServer(root) {
  const base = fs.realpathSync(path.resolve(root));

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return reply(res, 405, 'Method Not Allowed');
    }
    const rawPath = (req.url || '/').split(/[?#]/)[0];
    if (!rawPath.startsWith('/')) return reply(res, 400, 'Bad Request');
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return reply(res, 400, 'Bad Request');
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return reply(res, 400, 'Bad Request');

    const segments = decoded.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.includes('..')) return reply(res, 403, 'Forbidden');
    if (segments.some((s) => s.toLowerCase() === '.git')) return reply(res, 404, 'Not Found');

    const lexical = path.join(base, ...segments);
    if (!inside(base, lexical)) return reply(res, 403, 'Forbidden');

    let real;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      return reply(res, 404, 'Not Found');
    }
    // A symlink inside the tree must not lead outside it.
    if (!inside(base, real)) return reply(res, 403, 'Forbidden');

    let st = fs.statSync(real);
    if (st.isDirectory()) {
      if (!rawPath.endsWith('/')) {
        res.writeHead(301, { location: `${rawPath}/`, 'cache-control': 'no-store' });
        return res.end();
      }
      real = path.join(real, 'index.html');
      try {
        real = fs.realpathSync(real);
        if (!inside(base, real)) return reply(res, 403, 'Forbidden');
        st = fs.statSync(real);
      } catch {
        return reply(res, 404, 'Not Found');
      }
    }
    if (!st.isFile()) return reply(res, 404, 'Not Found');

    res.writeHead(200, {
      'content-type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] || '.';
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1) {
    console.error('static-server: set PORT to the port to listen on');
    process.exit(2);
  }
  const server = createStaticServer(root);
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`serving ${path.resolve(root)} on port ${port}`);
  });
}
