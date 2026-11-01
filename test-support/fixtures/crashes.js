// Exits straight away with a noisy log.
import fs from 'node:fs';
import path from 'node:path';

if (process.env.WTP_TEST_PIDS) fs.writeFileSync(path.join(process.env.WTP_TEST_PIDS, String(process.pid)), '');
const n = Number(process.env.FIXTURE_NOISE || 0);
for (let i = 1; i <= n; i++) console.error(`noise ${i}`);
console.error('boom: simulated crash at start');
process.exit(3);
