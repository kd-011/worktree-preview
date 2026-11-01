import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { EXIT, WtpError } from './errors.js';

const HELP = `worktree-preview: run any git worktree on its own free port.

Usage: wtp <command> [options]

Commands:
  up [path]          Start (or find) the preview for a worktree and print its URL.
                       --port N      use exactly this port (fails if it is taken)
                       --cmd "..."   command to run (overrides config and detection)
                       --name X      name for the preview (default: directory name)
                       --wait SECS   how long to wait for the server (default 60)
                       --open        open the URL in a browser
                       --json        print {name,url,port,pid,log,path,branch}
  ls [--json]        List previews: name, branch, port, pid, uptime, url, state.
  logs <name|path>   Show the preview log (-n LINES, -f to follow).
  down [name|path]   Stop a preview (no argument: the current worktree's).
                       --all         stop every preview wtp started
  gc                 Remove dead entries and orphaned logs.
                       --worktrees-gone   also stop previews whose worktree was deleted
  doctor             Check git, node, the state directory and the port range.

Exit codes: 0 ok, 1 failed to start or not healthy, 2 usage or config error,
3 not a git worktree. An interrupted \`up\` exits 130 (SIGINT), 143 (SIGTERM)
or 129 (SIGHUP).

Environment: XDG_STATE_HOME, WTP_PORT_RANGE (default 4100-4199),
WTP_TERM_GRACE_MS (default 5000), BROWSER.
Alias: wtp = worktree-preview. Linux and macOS only.
`;

const COMMON = { help: { type: 'boolean', short: 'h' } };

const SPECS = {
  up: { port: { type: 'string' }, cmd: { type: 'string' }, name: { type: 'string' }, wait: { type: 'string' }, open: { type: 'boolean' }, json: { type: 'boolean' } },
  ls: { json: { type: 'boolean' } },
  logs: { follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' } },
  down: { all: { type: 'boolean' } },
  gc: { 'worktrees-gone': { type: 'boolean' } },
  doctor: {},
};

function usage(msg) {
  return new WtpError(`${msg} (try: wtp --help)`, EXIT.USAGE);
}

function intOption(value, flag, { min, max }) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || n < min || n > max) throw usage(`${flag} must be a whole number from ${min} to ${max}, got "${value}"`);
  return n;
}

function parse(command, argv, maxPositionals) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { ...COMMON, ...SPECS[command] }, allowPositionals: true, strict: true });
  } catch (e) {
    throw usage(e.message.split('\n')[0]);
  }
  if (parsed.positionals.length > maxPositionals) throw usage(`unexpected argument "${parsed.positionals[maxPositionals]}"`);
  return parsed;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return command ? EXIT.OK : EXIT.USAGE;
  }
  if (command === '--version' || command === '-v') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.OK;
  }
  if (!(command in SPECS)) throw usage(`unknown command "${command}"`);
  if (process.platform === 'win32') throw new WtpError('Windows is not supported; use Linux or macOS (WSL works)', EXIT.USAGE);

  const { values, positionals } = parse(command, rest, command === 'gc' || command === 'ls' || command === 'doctor' ? 0 : 1);
  if (values.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (command) {
    case 'up': {
      const { up } = await import('./commands/up.js');
      await up({
        path: positionals[0],
        port: intOption(values.port, '--port', { min: 1, max: 65535 }),
        cmd: values.cmd,
        name: values.name,
        wait: values.wait === undefined ? undefined : intOption(values.wait, '--wait', { min: 1, max: 86400 }),
        open: values.open,
        json: values.json,
      });
      return EXIT.OK;
    }
    case 'ls': {
      const { ls } = await import('./commands/ls.js');
      await ls({ json: values.json });
      return EXIT.OK;
    }
    case 'logs': {
      const { logs } = await import('./commands/logs.js');
      await logs({ target: positionals[0], follow: values.follow, lines: intOption(values.lines, '-n', { min: 1, max: 100000 }) });
      return EXIT.OK;
    }
    case 'down': {
      const { down } = await import('./commands/down.js');
      if (values.all && positionals.length) throw usage('--all takes no name or path');
      await down({ target: positionals[0], all: values.all });
      return EXIT.OK;
    }
    case 'gc': {
      const { gc } = await import('./commands/gc.js');
      await gc({ worktreesGone: values['worktrees-gone'] });
      return EXIT.OK;
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.js');
      return doctor();
    }
  }
}

export async function run(argv) {
  try {
    return (await main(argv)) ?? EXIT.OK;
  } catch (e) {
    if (e instanceof WtpError) {
      process.stderr.write(`wtp: ${e.message}\n`);
      if (e.details) process.stderr.write(`${e.detailsHeader ? `${e.detailsHeader}\n` : ''}${e.details}\n`);
      return e.exitCode;
    }
    process.stderr.write(`wtp: unexpected error: ${process.env.WTP_DEBUG ? e.stack : e.message}\n`);
    return EXIT.FAILED;
  }
}
