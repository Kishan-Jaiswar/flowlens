# @flowlens/core

The graph engine behind [FlowLens](https://github.com/Kishan-Jaiswar/flowlens):
static analyzers, the flow resolver, field-level data lineage and impact
analysis.

Most people want the CLI instead:

```bash
npx @flowlens/cli scan .
```

This package is the programmatic API — for an editor extension, a CI check, or
any tool that needs the graph rather than the report.

It reads source files only. Nothing here connects to a database or executes the
code it analyses.

## Usage

```js
import { resolveFlows, scan, whereIs } from '@flowslens/core';

const { graph, seam, stats } = scan({ root: './my-app' });

// Every user action that reaches the backend.
for (const flow of resolveFlows(graph)) {
  console.log(flow.title, flow.endpoints, flow.risk.level);
}

// "Which features run through this line?"
const report = whereIs(graph, 'src/components/OrderForm.tsx:20');
console.log(report.flows.map((flow) => flow.title));
```

## What it produces

A `FlowGraph` of typed nodes — `ui-action`, `component`, `handler`, `state`,
`hook`, `api-call`, `route`, `controller`, `service`, `method`, `dto`, `model`,
`db-op`, `collection`, `field` — joined by typed edges (`triggers`, `requests`,
`handled-by`, `queries`, `writes`, `flows-to`, …).

Every node and edge carries `evidence`: `static` when analysis proved the path
*can* exist, `runtime` when a trace observed it, `confirmed` when both agree.

## Main exports

| Export                            | Purpose                                     |
| --------------------------------- | ------------------------------------------- |
| `scan(options)`                   | Read a project and build the graph.         |
| `FlowGraph`                       | The graph, with traversal helpers.          |
| `resolveFlows` / `resolveFlow`    | One user action, end to end.                |
| `whereIs`                         | Features running through a `file:line`.     |
| `analyzeImpact`                   | "If I change this, what breaks?"            |
| `findBrokenCalls`, `findSharedWrites`, `findDeadEndpoints` | Findings. |
| `linkDataLineage`                 | `state → payload → DTO → collection`.       |
| `renderFlowTree`, `renderFeatureDocument` | Text and markdown output.           |
| `mergeRuntimeTrace`               | Fold recorded spans into a scanned graph.   |

## Documentation

**https://github.com/Kishan-Jaiswar/flowlens** —
[architecture notes](https://github.com/Kishan-Jaiswar/flowlens/blob/main/docs/ARCHITECTURE.md).

## Licence

MIT
