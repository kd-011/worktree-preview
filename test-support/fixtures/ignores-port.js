// Dev server that ignores PORT and binds a random port of its own.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.env.WTP_TEST_PIDS) fs.writeFileSync(path.join(process.env.WTP_TEST_PIDS, String(process.pid)), '');
http.createServer((req, res) => res.end('elsewhere')).listen(0, () => console.log('listening somewhere else'));
