import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  analyzeChanged,
  analyzeImpact,
  actionQueries,
  explainAction,
  findNodes,
  flowTiming,
  indexTests,
  isWhereFailure,
  mergeRuntimeTrace,
  parseTraceFile,
  planTests,
  projectFindings,
  projectUnused,
  renderActionDocument,
  resolveFlows,
  scan,
  SourceReader,
  testsForFlow,
  whereIs,
  type FeatureFlow,
  type FlowGraph,
} from '@flowslens/core';
import { changedFiles } from '../changedfiles.js';
import { tracePath } from '../paths.js';
import { renderUnused } from './unused.js';

/**
 * `flowlens mcp` — the graph, as tools an AI assistant can call.
 *
 * An assistant asked "what breaks if I change `deleteMedicine`?" greps, reads a
 * handful of files and guesses. The graph already knows — from the source, and
 * confirmed by runtime spans where they exist — so this answers from it:
 * which actions run through a line, what a change reaches, what an action does
 * end to end, what is wrong with it, and what tests it lacks.
 *
 * The Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, started by the assistant as a child process. Nothing listens
 * on a port, nothing leaves the machine, and every tool is read-only — the
 * assistant can ask, never write. Written by hand rather than with the SDK:
 * the protocol subset tools need is small, and the CLI keeps having no
 * dependencies beyond its own core.
 */
export interface McpArgs {
  root: string;
  extraRoots?: string[];
  trace?: string;
  version: string;
  /** For tests; default stdin/stdout. */
  input?: Readable;
  output?: Writable;
}

/** The newest protocol revision this server speaks. */
const PROTOCOL_VERSION = '2025-06-18';
/** Revisions a client may ask for; anything else gets ours. */
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): string;
}

export function runMcp(args: McpArgs): number {
  const root = resolve(args.root);
  const input = args.input ?? process.stdin;
  const output = args.output ?? process.stdout;

  // Everything is built on first use and dropped by `rescan`: an assistant
  // that only asks about findings should not wait for a test index.
  let graph: FlowGraph | undefined;
  let flows: FeatureFlow[] | undefined;
  let reader: SourceReader | undefined;
  let findings: ReturnType<typeof projectFindings> | undefined;

  const load = (): FlowGraph => {
    if (graph) return graph;
    const result = scan({ root, ...(args.extraRoots ? { extraRoots: args.extraRoots } : {}) });
    const traceFile = tracePath(root, args.trace);
    if (existsSync(traceFile)) {
      mergeRuntimeTrace(result.graph, parseTraceFile(readFileSync(traceFile, 'utf8')));
    }
    graph = result.graph;
    return graph;
  };
  const allFlows = (): FeatureFlow[] =>
    (flows ??= resolveFlows(load(), { includeLocalOnly: true }));
  const sourceReader = (): SourceReader => (reader ??= new SourceReader(load()));
  const projectIssues = () => (findings ??= projectFindings(load(), { reader: sourceReader() }));

  /** An action by id, or by the words of its title when that is unambiguous. */
  const findAction = (query: unknown): FeatureFlow => {
    const text = String(query ?? '').trim();
    if (!text) throw new ToolError('Say which action: its id or title (see list_actions).');
    const every = allFlows();
    const exact = every.find((flow) => flow.id === text);
    if (exact) return exact;
    const words = text.toLowerCase().split(/\s+/);
    const hits = every.filter((flow) =>
      words.every((word) => `${flow.title} ${flow.id}`.toLowerCase().includes(word)),
    );
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) throw new ToolError(`No action matches "${text}". Try list_actions.`);
    throw new ToolError(
      `"${text}" matches ${hits.length} actions — use an id:\n` +
        hits
          .slice(0, 10)
          .map((flow) => `- ${flow.id} — ${flow.title}`)
          .join('\n'),
    );
  };

  const tools: Tool[] = [
    {
      name: 'list_actions',
      description:
        'Every user action in the app (a click, a submit, a page load) that FlowLens traced from the UI to the database, riskiest first. Use it to find the id other tools take.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Words the title or endpoint must contain, e.g. "delete medicine".',
          },
          includeLocalOnly: {
            type: 'boolean',
            description: 'Also list actions that never call the backend.',
          },
        },
      },
      run(input) {
        const words = String(input['filter'] ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const rows = allFlows()
          .filter((flow) => input['includeLocalOnly'] === true || flow.hitsBackend)
          .filter((flow) => {
            const text = `${flow.title} ${flow.id} ${flow.endpoints.join(' ')}`.toLowerCase();
            return words.every((word) => text.includes(word));
          });
        if (rows.length === 0) return 'No action matches.';
        return rows
          .map(
            (flow) =>
              `- ${flow.id} — ${flow.title} [risk ${flow.risk.level}, ${flow.evidence}]` +
              (flow.endpoints.length ? ` → ${flow.endpoints.join(', ')}` : '') +
              (flow.source ? ` (${flow.source.file}:${flow.source.line})` : ''),
          )
          .join('\n');
      },
    },
    {
      name: 'explain_action',
      description:
        'One action end to end, as a document: the handler, validation in the browser and on the server, the request and headers, the route, auth checks, business rules, every database operation, every response the route can send, and what the screen does on success and failure — each with file:line.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'Action id or title.' } },
        required: ['action'],
      },
      run(input) {
        const flow = findAction(input['action']);
        return renderActionDocument(explainAction(load(), flow, { reader: sourceReader() }));
      },
    },
    {
      name: 'where_is_code_used',
      description:
        'Which user actions run through a file or a line — "what is this code for?". Answer before editing unfamiliar code.',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'A project-relative path, optionally with a line: lib/db/store.ts:849',
          },
        },
        required: ['location'],
      },
      run(input) {
        const report = whereIs(load(), String(input['location'] ?? ''), { root });
        if (isWhereFailure(report)) {
          return report.reason === 'ambiguous-file'
            ? `Several files match — say which:\n${report.candidates.map((file) => `- ${file}`).join('\n')}`
            : `FlowLens has no step in ${report.file}: it may be config, styles, or code no action reaches.`;
        }
        const lines = [
          `${report.file}${report.line ? `:${report.line}` : ''}`,
          report.matches.length
            ? `At this spot: ${report.matches.map((node) => `${node.label} (${node.kind})`).join(', ')}`
            : 'Nothing declared on this line; the nearest steps are listed below.',
          '',
          report.flows.length ? 'Actions that run through it:' : 'No action runs through it.',
          ...report.flows.map((hit) => `- ${hit.id} — ${hit.title} [risk ${hit.risk}]`),
        ];
        if (report.otherFlowsInFile.length) {
          lines.push(
            '',
            'Other actions elsewhere in this file:',
            ...report.otherFlowsInFile.slice(0, 15).map((hit) => `- ${hit.id} — ${hit.title}`),
          );
        }
        return lines.join('\n');
      },
    },
    {
      name: 'impact_of_change',
      description:
        'What breaks if a function, method, route or collection changes: every action and step that depends on it, the collections it reaches, and a risk level. Walks the graph backwards from the symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'e.g. deleteMedicine, CustomersService.create, "POST /orders", medicines',
          },
        },
        required: ['symbol'],
      },
      run(input) {
        const query = String(input['symbol'] ?? '');
        const candidates = findNodes(load(), query);
        const target = candidates[0];
        if (!target) throw new ToolError(`Nothing in the graph matches "${query}".`);
        const report = analyzeImpact(load(), target.id, { flows: allFlows() });
        if (!report) throw new ToolError(`Could not analyse ${target.label}.`);
        const others = candidates.slice(1, 6).map((node) => node.label);
        return [
          `${report.target.label} (${report.target.kind})` +
            (report.target.file ? ` — ${report.target.file}:${report.target.line ?? ''}` : ''),
          others.length ? `Also matched: ${others.join(', ')}` : '',
          `Blast radius: ${report.blastRadius} steps · risk ${report.level}`,
          '',
          `Actions affected (${report.affectedFlows.length}):`,
          ...report.affectedFlows.map((flow) => `- ${flow.id} — ${flow.title}`),
          report.endpoints.length ? `\nEndpoints leading here: ${report.endpoints.join(', ')}` : '',
          report.collections.length ? `Collections reached: ${report.collections.join(', ')}` : '',
          '',
          'Nearest dependents:',
          ...report.dependents
            .slice(0, 25)
            .map(
              (entry) =>
                `- ${entry.label} (${entry.kind}, ${entry.distance} hop${entry.distance === 1 ? '' : 's'})` +
                (entry.file ? ` ${entry.file}:${entry.line ?? ''}` : ''),
            ),
          ...report.warnings.map((warning) => `Note: ${warning}`),
        ]
          .filter((line) => line !== '')
          .join('\n');
      },
    },
    {
      name: 'find_issues',
      description:
        'Bugs the code shows, each with the line to open, why it matters and how to fix it: routes with no auth check, queries missing the tenant filter, tenant id taken from the request, mass assignment, N+1 queries, independent reads awaited one after another.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Only this severity and above.',
          },
          file: { type: 'string', description: 'Only findings in this file.' },
          action: { type: 'string', description: 'Only findings on this action (id or title).' },
        },
      },
      run(input) {
        const order = { high: 0, medium: 1, low: 2 } as const;
        const floor = order[input['severity'] as keyof typeof order] ?? 2;
        const file = input['file'] ? String(input['file']) : undefined;
        const action = input['action'] ? findAction(input['action']).id : undefined;
        const report = projectIssues();
        const hits = report.findings.filter(
          (finding) =>
            order[finding.severity] <= floor &&
            (!file || finding.at.file === file) &&
            (!action || finding.flowIds.includes(action)),
        );
        if (hits.length === 0) {
          return `No findings${file || action || input['severity'] ? ' match' : ''}. Checked ${report.checked.routes} routes and ${report.checked.queries} queries.`;
        }
        return hits
          .map((finding) =>
            [
              `## [${finding.severity}] ${finding.title}`,
              `${finding.at.file}:${finding.at.line}`,
              `Why: ${finding.why}`,
              `Fix: ${finding.fix}`,
              ...(finding.related ?? []).map(
                (entry) => `See: ${entry.text} — ${entry.at.file}:${entry.at.line}`,
              ),
            ].join('\n'),
          )
          .join('\n\n');
      },
    },
    {
      name: 'changes_impact',
      description:
        'Which user actions the uncommitted changes (or the changes since a git ref) reach, which of them have no test, and which files FlowLens cannot see into. Use before committing or reviewing.',
      inputSchema: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'Compare against this git ref, e.g. main. Default: the last commit.',
          },
        },
      },
      run(input) {
        const found = changedFiles(root, input['base'] ? String(input['base']) : undefined);
        if (found.error !== undefined) throw new ToolError(found.error);
        const report = analyzeChanged(load(), found.files, {
          tests: indexTests([root, ...(args.extraRoots ?? [])]),
        });
        return [
          `Against ${found.against}: ${report.summary} Risk: ${report.level}.`,
          '',
          ...report.features.map(
            (feature) =>
              `- ${feature.id} — ${feature.title}${feature.subtitle ? ` · ${feature.subtitle}` : ''}` +
              (feature.touchedSteps.length
                ? `: ${feature.touchedSteps.map((step) => step.label).join(', ')}`
                : '') +
              (feature.through.length
                ? ` (through an import of ${feature.through.join(', ')})`
                : '') +
              (feature.testCases === 0 ? ' — no test' : ` — ${feature.testCases} tests`),
          ),
          report.collections.length ? `\nData touched: ${report.collections.join(', ')}` : '',
          ...report.notes.map((note) => `Note: ${note}`),
        ]
          .filter((line) => line !== '')
          .join('\n');
      },
    },
    {
      name: 'tests_for_action',
      description:
        'What tests cover an action, and the tests worth writing for it — every response the route can send, every write, and what the user sees on failure — as an it.todo skeleton for Vitest or Jest, with where to put the file.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'Action id or title.' } },
        required: ['action'],
      },
      run(input) {
        const flow = findAction(input['action']);
        const coverage = testsForFlow(indexTests([root, ...(args.extraRoots ?? [])]), flow);
        const plan = planTests(explainAction(load(), flow, { reader: sourceReader() }), flow);
        return [
          `${flow.title}: ${coverage.totalCases} test case${coverage.totalCases === 1 ? '' : 's'} reach it; ${coverage.coveragePct}% of its files are imported by a test.`,
          ...coverage.files.map((file) => `- ${file.file} (${file.cases.length} cases)`),
          '',
          plan.cases.length ? 'Tests worth writing, most important first:' : '',
          plan.file ? `Request tests in ${plan.file}` : '',
          plan.screenFile ? `Screen tests in ${plan.screenFile}` : '',
          plan.cases.length ? `\n${plan.skeleton}` : 'No cases could be read off this action.',
        ]
          .filter((line) => line !== '')
          .join('\n');
      },
    },
    {
      name: 'action_performance',
      description:
        'Where the time goes in an action, from real runtime spans: time per step, each database query with its code and timings, and how many runs the numbers rest on. Says plainly when nothing was measured.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'Action id or title.' } },
        required: ['action'],
      },
      run(input) {
        const flow = findAction(input['action']);
        const timing = flowTiming(flow);
        const queries = actionQueries(load(), flow, { reader: sourceReader() });
        const lines = [
          timing.observed
            ? `${flow.title}: the user waits about ${timing.totalMs}ms.`
            : `${flow.title}: not measured yet — run the app with FlowLens tracing (flowlens instrument) and do the action.`,
          ...timing.steps.map(
            (step) =>
              `- ${step.label} (${step.kind}): ${step.avgSelfMs ?? 0}ms own, ${step.avgMs ?? '?'}ms total, ${step.observations ?? 0} run(s)`,
          ),
          '',
          'Database queries:',
          ...queries.queries.map(
            (query) =>
              `- ${query.collection}.${query.operation}` +
              (query.timing
                ? ` — avg ${query.timing.avgMs}ms (min ${query.timing.minMs}, max ${query.timing.maxMs}, ${query.timing.count} runs)`
                : ' — not measured') +
              (query.at ? ` ${query.at.file}:${query.at.line}` : '') +
              (query.code ? `\n    ${query.code.split('\n').join('\n    ')}` : ''),
          ),
          ...timing.notes.map((note) => `Note: ${note}`),
        ];
        return lines.join('\n');
      },
    },
    {
      name: 'find_unused',
      description:
        'Code nothing uses: files and folders no entry point reaches, exports nothing imports, dependencies nothing imports, relative imports that point at no file, and backend routes no frontend calls. Use before deleting code or to clean up.',
      inputSchema: {
        type: 'object',
        properties: {
          all: {
            type: 'boolean',
            description: 'Also list exports only used inside their own file.',
          },
        },
      },
      run(input) {
        // The CLI's own report; stdout is a pipe here, so it carries no colour.
        return renderUnused(projectUnused(load()), input['all'] === true).trim();
      },
    },
    {
      name: 'rescan',
      description:
        'Read the source again (and the latest runtime spans). Call after editing files, so answers reflect the current code.',
      inputSchema: { type: 'object', properties: {} },
      run() {
        graph = undefined;
        flows = undefined;
        reader = undefined;
        findings = undefined;
        const fresh = load();
        return `Rescanned ${root}: ${fresh.nodeCount} steps, ${allFlows().filter((flow) => flow.hitsBackend).length} actions that reach the backend.`;
      },
    },
  ];

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: Request['id'], result: unknown): void =>
    send({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (id: Request['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  const handle = (request: Request): void => {
    const isNotification = request.id === undefined;
    switch (request.method) {
      case 'initialize': {
        const asked = String(request.params?.['protocolVersion'] ?? '');
        reply(request.id, {
          protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'flowlens', version: args.version },
          instructions:
            'FlowLens knows this app as user actions traced from the UI to the database. ' +
            'Before editing unfamiliar code call where_is_code_used; before changing a ' +
            'function call impact_of_change; to understand a feature call explain_action.',
        });
        return;
      }
      case 'ping':
        reply(request.id, {});
        return;
      case 'tools/list':
        reply(request.id, {
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          })),
        });
        return;
      case 'tools/call': {
        const name = String(request.params?.['name'] ?? '');
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          fail(request.id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const input = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
        try {
          reply(request.id, { content: [{ type: 'text', text: tool.run(input) }] });
        } catch (error) {
          // A tool that cannot answer says why, as a result the model can read —
          // not a protocol error, which a client shows as "the server broke".
          const message = error instanceof Error ? error.message : String(error);
          reply(request.id, {
            content: [
              {
                type: 'text',
                text: error instanceof ToolError ? message : `FlowLens failed: ${message}`,
              },
            ],
            isError: true,
          });
        }
        return;
      }
      default:
        // Notifications (`notifications/initialized`, cancellations) need no answer.
        if (!isNotification) fail(request.id, -32601, `Method not found: ${request.method}`);
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      fail(null, -32700, 'Parse error');
      return;
    }
    if (!request || typeof request.method !== 'string') {
      fail(request?.id, -32600, 'Invalid request');
      return;
    }
    handle(request);
  });

  process.stderr.write(`[flowlens] MCP server ready for ${root}\n`);
  return 0;
}

/** A failure the assistant should read and act on, not a crash. */
class ToolError extends Error {}
