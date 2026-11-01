import http from 'node:http';

// Honours PORT, which is all worktree-preview needs from a dev server.
const port = Number(process.env.PORT ?? 3000);

http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Hello from ${process.cwd()}\n`);
  })
  .listen(port, () => console.log(`listening on ${port}`));
