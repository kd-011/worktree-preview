// A tiny dev server that honours PORT (or the variable named by FIXTURE_PORT_VAR).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.env.WTP_TEST_PIDS) fs.writeFileSync(path.join(process.env.WTP_TEST_PIDS, String(process.pid)), '');

const portVar = process.env.FIXTURE_PORT_VAR || 'PORT';
const port = Number(process.env[portVar]);
const delay = Number(process.env.FIXTURE_DELAY_MS || 0);
const rootStatus = Number(process.env.FIXTURE_ROOT_STATUS || 200);

function cwd() {
  try {
    return fs.realpathSync(process.cwd());
  } catch {
    return '(deleted)';
  }
}

function marker() {
  try {
    return fs.readFileSync('marker.txt', 'utf8').trim();
  } catch {
    return '';
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url === '/env') {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({ PORT: process.env.PORT, WTP_PORT: process.env.WTP_PORT, WTP_NAME: process.env.WTP_NAME }),
    );
  }
  res.statusCode = rootStatus;
  res.end(`cwd=${cwd()}\nmarker=${marker()}\nport_var=${portVar}\n`);
});

setTimeout(() => {
  server.listen(port, () => console.log(`listening on ${port}`));
}, delay);
