import http from 'node:http';

/**
 * One readiness probe: GET path on loopback (IPv4 first, then IPv6, because dev
 * servers differ in what "localhost" binds). Resolves { status } for any HTTP
 * answer and { status: null } when nothing answered.
 */
export async function probe(port, readyPath = '/', { timeoutMs = 1500, signal } = {}) {
  for (const host of ['127.0.0.1', '::1']) {
    const status = await new Promise((resolve) => {
      const req = http.request({ host, port, path: readyPath, method: 'GET', agent: false, timeout: timeoutMs, signal }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
    if (status !== null) return { status };
  }
  return { status: null };
}

/** Ready means: it answered, and not with a server error. */
export const isReady = (r) => r.status !== null && r.status < 500;
