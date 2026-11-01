// Parent that never listens; a child process (same group) is the real server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.WTP_TEST_PIDS) fs.writeFileSync(path.join(process.env.WTP_TEST_PIDS, String(process.pid)), '');
spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { stdio: 'inherit' });
setInterval(() => {}, 1000);
