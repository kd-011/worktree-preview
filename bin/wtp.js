#!/usr/bin/env node
import { run } from '../src/cli.js';

// `wtp ls | head` closes our stdout early; that is not an error.
process.stdout.on('error', (e) => {
  if (e.code !== 'EPIPE') throw e;
});

process.exitCode = await run(process.argv.slice(2));
