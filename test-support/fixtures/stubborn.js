// Like server.js, but ignores SIGTERM so only SIGKILL stops it.
process.on('SIGTERM', () => {});
await import('./server.js');
