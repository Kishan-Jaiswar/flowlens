import { parseArgs } from 'node:util';
import { loadConfig } from '@flowlens/core';
import { splitPositionals } from './args.js';
import { runFlow, runFlows } from './commands/flows.js';
import { runDoctor, runImpact } from './commands/impact.js';
import { runInit } from './commands/init.js';
import { runScan } from './commands/scan.js';
import { runServe } from './commands/serve.js';
import { runTrace } from './commands/trace.js';
import { runWhere } from './commands/where.js';
import { color } from './ui.js';

const VERSION = '0.1.0';

const HELP = `
${color.bold('FlowLens')} — trace any user action from the UI to the database.

${color.bold('USAGE')}
  flowlens <command> [project] [options]

${color.bold('COMMANDS')}
  init [project]          Detect the layout and write flowlens.config.json
  scan [project]          Read the source and build the flow graph
  flows [project]         List every user action that reaches the backend
  flow <id> [project]     Show one feature end to end (add --markdown for a doc)
  where <file>:<line>     "What is this code for?" — features running through it
  impact <symbol>         "If I change this, what breaks?"
  doctor [project]        Broken API calls, dead endpoints, shared writes
  trace [project]         Merge recorded runtime spans into the graph
  serve [project]         Open the dashboard (default http://127.0.0.1:4177)

${color.bold('OPTIONS')}
  -p, --project <dir>     Project root (repeatable — scan siblings together)
  -g, --graph <file>      Graph file (default: <project>/.flowlens/graph.json)
      --trace <file>      Trace file (default: <project>/.flowlens/trace.jsonl)
  -o, --out <file>        Write output to a file
      --json              Machine-readable output
      --markdown          Render a feature document (flow command)
      --all               Include UI actions that never call the backend
      --api-prefix <p>    Strip this prefix from BOTH frontend URLs and backend
                          routes (repeatable, default /api)
      --request-fn <re>   Regex for wrapper functions whose name holds the verb.
                          Capture group 1 is the method.
                          default ^(get|post|put|patch|delete)Request[A-Za-z0-9_]*$
      --http-client <id>  Identifier treated as an HTTP client (repeatable)
      --no-constants      Do not resolve URL constants to their literal value
  -c, --config <file>     Config file (default: nearest flowlens.config.json)
      --max-files <n>     Cap on files parsed (default 20000)
      --ignore <dir>      Skip a directory (repeatable)
      --include-tests     Analyze test files too
      --port <n>          Dashboard port (serve, default 4177; the next free
                          port is used if it is busy)
      --host <h>          Dashboard host (serve, default 127.0.0.1)
      --open              Open a browser (serve; on by default in a terminal)
      --no-open           Do not open a browser
      --force             Overwrite an existing config (init)
      --print             Print the config instead of writing it (init)
  -q, --quiet             Print only the essentials
  -h, --help              Show this help
  -v, --version           Show the version

${color.bold('EXAMPLES')}
  flowlens init                            # in the project you want to read
  flowlens scan                            # then this, from anywhere in it
  flowlens scan my-app                     # or name it — any OS, any spelling
  flowlens scan ./my-web ./my-api          # separate repos, one graph
  flowlens flows my-app
  flowlens flow create-customer my-app
  flowlens flow create-customer my-app --markdown --out docs/create-customer.md
  flowlens where web/src/components/OrderForm.tsx:20 my-app
  flowlens impact CustomersService.create -p my-app
  flowlens serve my-app

${color.bold('ENVIRONMENT')}
  FLOWLENS_ASCII=1        Draw trees with plain ASCII (old Windows consoles)
  FLOWLENS_UNICODE=1      Force box-drawing characters back on
  NO_COLOR=1              Disable colour

${color.gray('FlowLens reads source files only. It never connects to a database and')}
${color.gray('never executes the code it analyzes. Runtime tracing is opt-in and')}
${color.gray('writes to a local .flowlens/trace.jsonl in your own project.')}
`;

export function main(argv = process.argv.slice(2)): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string', short: 'p', multiple: true },
        'request-fn': { type: 'string' },
        'http-client': { type: 'string', multiple: true },
        'no-constants': { type: 'boolean', default: false },
        config: { type: 'string', short: 'c' },
        'max-files': { type: 'string' },
        graph: { type: 'string', short: 'g' },
        trace: { type: 'string' },
        out: { type: 'string', short: 'o' },
        json: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        'api-prefix': { type: 'string', multiple: true },
        ignore: { type: 'string', multiple: true },
        'include-tests': { type: 'boolean', default: false },
        port: { type: 'string' },
        host: { type: 'string' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        print: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(
      `${color.red('error')} ${(error as Error).message}\n\nRun \`flowlens --help\`.\n`,
    );
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = positionals;

  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return command ? 0 : values.help ? 0 : 1;
  }

  /**
   * Projects come from --project (repeatable), else from the positionals, else
   * the current directory.
   *
   * Several roots are allowed because a frontend and backend often live in
   * sibling repositories, and the seam between them is the point:
   *
   *   flowlens scan ./shop-web ./shop-backend
   *
   * `splitPositionals` is what makes `flowlens scan .\my-app` (Windows) and
   * `flowlens scan my-app` (no separator at all) work rather than silently
   * scanning the current directory. See args.ts.
   */
  const { roots: pathLike, args } = splitPositionals(command, rest);
  const projects = values.project ?? [];

  /**
   * A `flowlens.config.json` beside the project describes conventions once, so
   * an unusual codebase does not need the same flags typed on every command.
   * Explicit paths and flags always win over the file.
   */
  const cliRoots = projects.length > 0 ? projects : pathLike;
  const { config: fileConfig, path: configPath } = loadConfig(cliRoots[0] ?? '.', values.config);
  const roots = cliRoots.length > 0 ? cliRoots : (fileConfig.roots ?? ['.']);

  const common = {
    root: roots[0]!,
    ...(roots.length > 1 ? { extraRoots: roots.slice(1) } : {}),
    ...(values.graph ? { graph: values.graph } : {}),
    ...(values.trace ? { trace: values.trace } : {}),
    json: values.json,
  };

  try {
    switch (command) {
      case 'init':
        // `common` already carries the primary root and any sibling roots.
        return runInit({
          ...common,
          force: values.force,
          print: values.print,
          quiet: values.quiet,
        });

      case 'scan':
        return runScan({
          // Config file first, then anything given explicitly on the CLI.
          ...(fileConfig.ignore ? { ignore: fileConfig.ignore } : {}),
          ...(fileConfig.apiPrefixes ? { apiPrefix: fileConfig.apiPrefixes } : {}),
          ...(fileConfig.requestFunctionPattern
            ? { requestFunctionPattern: fileConfig.requestFunctionPattern }
            : {}),
          ...(fileConfig.httpClients ? { httpClients: fileConfig.httpClients } : {}),
          ...(fileConfig.maxFiles ? { maxFiles: fileConfig.maxFiles } : {}),
          ...(fileConfig.includeTests !== undefined
            ? { includeTests: fileConfig.includeTests }
            : {}),
          ...(fileConfig.resolveConstants !== undefined
            ? { resolveConstants: fileConfig.resolveConstants }
            : {}),
          ...common,
          ...(values.out ? { out: values.out } : {}),
          quiet: values.quiet,
          ...(values['include-tests'] ? { includeTests: true } : {}),
          ...(values.ignore ? { ignore: values.ignore } : {}),
          ...(values['api-prefix'] ? { apiPrefix: values['api-prefix'] } : {}),
          ...(values['request-fn'] ? { requestFunctionPattern: values['request-fn'] } : {}),
          ...(values['http-client'] ? { httpClients: values['http-client'] } : {}),
          ...(values['max-files'] ? { maxFiles: Number(values['max-files']) } : {}),
          ...(values['no-constants'] ? { resolveConstants: false } : {}),
          ...(configPath ? { configPath } : {}),
        });

      case 'flows':
        return runFlows({ ...common, all: values.all });

      case 'flow': {
        const id = args[0];
        if (!id) {
          process.stderr.write(`${color.red('error')} flow id required: flowlens flow <id>\n`);
          return 1;
        }
        return runFlow({
          ...common,
          id,
          markdown: values.markdown,
          ...(values.out ? { out: values.out } : {}),
        });
      }

      case 'where': {
        const location = args[0];
        if (!location) {
          process.stderr.write(
            `${color.red('error')} location required: flowlens where src/App.tsx:42\n`,
          );
          return 1;
        }
        return runWhere({ ...common, location });
      }

      case 'impact': {
        const query = args[0];
        if (!query) {
          process.stderr.write(
            `${color.red('error')} symbol required: flowlens impact CustomersService.create\n`,
          );
          return 1;
        }
        return runImpact({ ...common, query });
      }

      case 'doctor':
        return runDoctor(common);

      case 'trace':
        return runTrace(common);

      case 'serve':
        return runServe({
          ...common,
          ...(values.port ? { port: Number(values.port) } : {}),
          ...(values.host ? { host: values.host } : {}),
          // A browser is a convenience for a person at a terminal. A piped or
          // scripted run gets the URL on stdout and nothing else.
          open: values['no-open']
            ? false
            : (values.open ?? (process.stdout.isTTY === true && !values.json)),
        });

      default:
        process.stderr.write(
          `${color.red('error')} unknown command "${command}"\n\nRun \`flowlens --help\`.\n`,
        );
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${color.red('error')} ${(error as Error).message}\n`);
    return 1;
  }
}
