# @flowslens/core

The graph engine behind [FlowLens](https://github.com/Kishan-Jaiswar/flowlens):
static analyzers, the flow resolver, field-level data lineage and impact
analysis.

## Do you want this package?

**Most people want the CLI instead.** It prints the reports, serves a dashboard,
and needs no code at all:

```bash
npx @flowslens/cli scan .
```

Reach for `@flowslens/core` when you need the **graph itself** rather than a
report — an editor extension, a CI check that fails a PR, a custom dashboard, a
script that answers a question the CLI does not.

It reads source files only. Nothing here connects to a database or runs the code
it analyses.

---

## Install

```bash
npm install @flowslens/core
```

Requires **Node 18.18 or newer**. One dependency (`ts-morph`, the TypeScript AST
reader).

### This package is ESM-only

There is no CommonJS build:

| Your project                         | Use this                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| ESM (`"type": "module"`, or `.mjs`)  | `import { scan } from '@flowslens/core'`                                 |
| **CommonJS on Node 22.12+**          | `require('@flowslens/core')` works                                       |
| **CommonJS on Node 18, 20 or 22.11** | `await import('@flowslens/core')` — `require()` throws `ERR_REQUIRE_ESM` |

---

## A complete first script

Save as `flowlens-check.mjs`, then `node flowlens-check.mjs`:

```js
import { resolveFlows, scan } from '@flowslens/core';

const { graph, stats } = scan({ root: './my-app' });

console.log(`${stats.filesAnalyzed} files, ${stats.apiCalls} API calls`);

for (const flow of resolveFlows(graph)) {
  console.log(`${flow.risk.level.padEnd(6)} ${flow.title} → ${flow.endpoints}`);
}
```

```text
1519 files, 204 API calls
high   Customers · Delete → DELETE /customers/:param
high   Submit Order → POST /orders
low    Customers · Search → GET /customers
```

That is the whole shape of the API: **`scan()` once, then ask the graph
questions.**

---

## `scan(options)`

```js
const result = scan({ root: './my-app' });
```

Returns `{ graph, seam, lineageLinks, stats, durationMs, constants, warnings,
diagnostics }`. Useful options:

| Option                   | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `root`                   | The project directory to read. **Required.**                      |
| `extraRoots`             | More directories, scanned into the same graph.                    |
| `apiPrefixes`            | Stripped from both frontend URLs and backend routes.              |
| `requestFunctionPattern` | Regex for a house-built request wrapper; group 1 is the verb.     |
| `httpClients`            | Identifiers treated as HTTP clients (`axios`, `api`, …).          |
| `ignore`                 | Directory names to skip.                                          |
| `includeTests`           | Include `*.test.ts` / `*.spec.ts` files. Off by default.          |
| `resolveConstants`       | Resolve endpoint constants to literals. On by default.            |
| `maxFiles`               | Safety valve when pointed somewhere enormous. Defaults to 20,000. |

Frontend and backend in separate repositories? Pass both — the seam between them
is the interesting part:

```js
scan({ root: './my-web', extraRoots: ['./my-api'] });
```

`loadConfig(dir)` reads an existing `flowlens.config.json` if you would rather
share settings with the CLI. It returns `{ config, path? }`, so spread the
`config` into your `scan` call:

```js
const { config } = loadConfig('./my-app');
scan({ root: './my-app', ...config });
```

---

## The three things you will actually do

### 1. List every feature that reaches the backend

```js
import { resolveFlows } from '@flowslens/core';

for (const flow of resolveFlows(graph)) {
  console.log(flow.id, flow.title, flow.endpoints, flow.risk.level);
}
```

A flow carries `id`, `label`, `title`, `screen`, `component`, `steps`, `state`,
`endpoints`, `controllers`, `services`, `collections`, `dtos`, `schemas`,
`hooks`, `evidence`, `hitsBackend`, `risk` and `source`.

To get a single flow, filter the list by `id`:

```js
const flow = resolveFlows(graph).find((f) => f.id === 'orderform-submit-order');
```

`resolveFlow(graph, entryNodeId)` also returns one, but it takes a node id —
`flow.entryNodeId` — rather than the flow id.

To render one:

```js
renderFlowTree(flow); // the CLI's tree, as a string
renderFlowTree(flow, { ascii: true }); // without box-drawing characters
renderFeatureDocument(graph, flow); // markdown — note it takes the graph too
```

### 2. Ask what a line of code is for

```js
import { whereIs } from '@flowslens/core';

const report = whereIs(graph, 'src/components/OrderForm.tsx:20');

console.log(report.flows.map((flow) => flow.title)); // [ 'Submit Order' ]
```

Returns `{ file, line, matches, fileNodes, flows, otherFlowsInFile }`. A line
inside a function body resolves to the nearest declaration above it, and the
report says so, rather than silently answering a different question.

### 3. Ask what breaks if you change something

`analyzeImpact` takes a **node id**, not a symbol name — so look it up first:

```js
import { analyzeImpact, findNodes } from '@flowslens/core';

const [target] = findNodes(graph, 'AuditService.record');
const report = analyzeImpact(graph, target.id);

console.log(report.blastRadius); // 36
console.log(report.level); // 'high'
console.log(report.affectedFlows.map((f) => f.title));
```

Returns `{ target, dependents, affectedFlows, collections, endpoints,
blastRadius, level, warnings }` — or `undefined` if the id is not in the graph.

---

## Failing a CI job on findings

Each finding function takes the graph and returns an array, which makes this a
three-line check:

```js
import {
  findBrokenCalls,
  findDeadEndpoints,
  findSharedWrites,
  scan,
} from '@flowslens/core';

const { graph } = scan({ root: '.' });

const broken = findBrokenCalls(graph); // frontend calls with no matching route
const dead = findDeadEndpoints(graph); // routes nothing calls
const shared = findSharedWrites(graph); // one collection, several writing services

if (broken.length > 0) {
  console.error(`${broken.length} API calls hit no backend route`);
  process.exitCode = 1;
}
```

---

## What the graph contains

Typed nodes — `ui-action`, `component`, `handler`, `state`, `hook`, `api-call`,
`route`, `controller`, `service`, `method`, `dto`, `model`, `db-op`,
`collection`, `field` — joined by typed edges (`triggers`, `requests`,
`handled-by`, `queries`, `writes`, `flows-to`, …).

`FlowGraph` has the traversal helpers: `graph.node(id)`, `graph.reachable(id,
{ direction, kinds })`, and JSON round-tripping.

Every node and edge carries `evidence`:

| Evidence    | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `static`    | Analysis proved the path _can_ exist.                       |
| `runtime`   | A trace observed it, but the analyzer never found it.       |
| `confirmed` | Both agree — and the trace carries how long each step took. |

`mergeRuntimeTrace(graph, events)` folds a recording from
[`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime) into a
scanned graph, which is what turns `static` into `confirmed`.

---

## Main exports

| Export                                                     | Purpose                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `scan(options)`                                            | Read a project and build the graph.       |
| `FlowGraph`                                                | The graph, with traversal helpers.        |
| `resolveFlows` / `resolveFlow`                             | One user action, end to end.              |
| `whereIs`                                                  | Features running through a `file:line`.   |
| `findNodes`                                                | Look a symbol up as graph nodes.          |
| `analyzeImpact`                                            | "If I change this, what breaks?"          |
| `findBrokenCalls`, `findSharedWrites`, `findDeadEndpoints` | Findings.                                 |
| `linkDataLineage`                                          | `state → payload → DTO → collection`.     |
| `renderFlowTree`, `renderFeatureDocument`                  | Text and markdown output.                 |
| `mergeRuntimeTrace`                                        | Fold recorded spans into a scanned graph. |
| `loadConfig`                                               | Read a `flowlens.config.json`.            |

Ships its own TypeScript types — no `@types` package needed.

---

## Related packages

- **[`@flowslens/cli`](https://www.npmjs.com/package/@flowslens/cli)** — the
  `flowlens` command and dashboard. Start here unless you need the graph itself.
- **[`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime)** —
  optional development-only tracer, so a step can be `confirmed` by a real
  request rather than only inferred from source.

## Documentation

**https://github.com/Kishan-Jaiswar/flowlens** —
[architecture notes](https://github.com/Kishan-Jaiswar/flowlens/blob/main/docs/ARCHITECTURE.md).

## Licence

MIT
