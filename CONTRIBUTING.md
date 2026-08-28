# Contributing to FlowLens

Thanks for looking. This file is short on ceremony and long on the things that
actually matter for this codebase.

## Getting set up

```bash
git clone https://github.com/Kishan-Jaiswar/flowlens.git
cd flowlens
nvm use            # or any Node >= 18.18
npm install        # also builds, via the prepare script
npm test           # 200 tests, ~8s
```

On Windows, `nvm use` has no equivalent — install Node 20 or newer and the rest
is the same. Every script in `package.json` is plain Node with no shell built
in, so they behave identically on all three operating systems. If you only want
to run FlowLens rather than work on it, `./flowlens` (or `flowlens.cmd`) does
the install and build for you on first use.

Try it against the bundled example, which is a source-only React + NestJS +
Mongoose app that is never executed:

```bash
npm run scan:example
npm run flows:example
npm run serve:example
```

## Before you open a PR

```bash
npm run verify     # lint + format check + build + tests
npm run smoke      # every CLI command, run for real, on this OS
```

CI runs the same thing on Node 20, 22, 24 and 26 on Linux and Node 24 on Windows
and macOS. It also runs the smoke test on all three operating systems, and the
launcher on all three from a checkout with nothing installed.

Because FlowLens is pointed at whatever a developer has on disk, on whatever
machine they have, anything touching paths, the file system or terminal output
deserves a thought about the other two platforms:

- Build paths with `node:path`, and convert to `/` only where a path leaves the
  program (node ids, config files, generated documents) — `tests/portability.test.ts`
  covers the argument-parsing side of this.
- Assume the file system may be case-insensitive (Windows, macOS) and that
  creating a symlink may not be permitted at all (Windows without Developer
  Mode).
- Terminal glyphs go through `glyphsFor()` in `packages/core/src/ui/glyphs.ts`,
  so the ASCII fallback stays in one place.

Node 18.18 is the declared floor in `engines`, but Vitest 4 cannot start on it
(rolldown needs `styleText` from `node:util`, added in 20.12). So the `compat`
job builds on 18.18 and runs the CLI against the example project instead — the
product is verified there, just not the test suite.

## The one rule that matters

**A wrong edge is worse than a missing edge.**

FlowLens tells developers what will break if they change something. If it says
"nothing else uses this" and something does, it has done real damage — worse than
if it had said "I don't know". So throughout the analyzers you will find code
that refuses to guess:

- a constant declared twice with different values is skipped, not resolved
- a URL that is entirely interpolated produces no endpoint
- a receiver that cannot be tied to a model produces no collection
- an unresolvable handler is marked `unresolved` rather than assumed

When you add a heuristic, add the case where it should _decline_, and test that
too.

## How the code is laid out

| Path                         | What lives there                                    |
| ---------------------------- | --------------------------------------------------- |
| `packages/core/src/graph`    | The graph engine: nodes, edges, traversal, evidence |
| `packages/core/src/analyzer` | Everything that reads source code                   |
| `packages/core/src/flow`     | Turning the graph into feature flows and documents  |
| `packages/core/src/impact`   | Walking the graph backwards                         |
| `packages/core/src/runtime`  | Merging recorded traces into the graph              |
| `packages/runtime`           | The tracer that runs inside _your_ app              |
| `packages/cli`               | The `flowlens` command                              |
| `apps/dashboard`             | Dependency-free browser UI, served by the CLI       |

`docs/ARCHITECTURE.md` explains why each pass runs in the order it does, and
documents the bugs that shaped the design. Read it before changing the analyzers
— several obvious-looking simplifications are obvious-looking mistakes, and the
reasons are written down.

## Adding support for a framework or database

This is the most useful contribution, and it is additive by design. A new data
layer means a new module that emits the same `db-op` and `collection` nodes:

```ts
// packages/core/src/analyzer/prisma.ts
export function analyzePrisma(loaded: LoadedProject, graph: FlowGraph) {
  // emit db-op nodes with { collection, operation, access }
  // and reads/writes edges to collection nodes
}
```

Nothing downstream — flows, impact, lineage, the dashboard — needs to change.
Same for frontends: emit `component`, `ui-action`, `handler` and `api-call`
nodes and the rest follows.

## Tests

Vitest, in `tests/`. Six kinds, all of which matter:

- `graph.test.ts`, `http.test.ts` — unit tests of the pure logic
- `analyzer.test.ts` — the tidy example app, asserting exact flows
- `realworld.test.ts` — a fixture shaped like production code: plain `.js`,
  wrapper functions, endpoint constants, a global `/api` prefix
- `structures.test.ts` — eleven project layouts, plus hostile inputs (symlink
  cycles, binary files, syntax errors, empty directories)
- `tracer.test.ts` — `@flowlens/runtime` driven through fake requests and fake
  Mongoose hooks, so no server or database is needed
- `server.test.ts` — spawns the real `flowlens serve` process and exercises the
  dashboard and its JSON API over HTTP

Fixtures under `tests/fixtures/` are deliberately _not_ formatted by Prettier.
They imitate real code, and tidying them would weaken what the tests check.

If you fix a bug, add the test that would have caught it. Every entry in the
"known limits" table in `docs/ARCHITECTURE.md` started as a surprise.

## Commit messages

Plain imperative subject lines, wrapped body if it needs one:

```
Strip the api prefix from backend routes as well as calls

Applying it to one side only meant 506 routes and 199 calls matched zero
times, which looks plausible and is useless.
```

No enforced convention beyond being readable.

## Reporting a bug

The most useful bug report for a static analyzer is a **minimal source snippet**
that is analyzed wrongly:

```
Expected: POST /users matched to UsersController.create
Actual:   POST /users reported as having no backend route

// the code, trimmed as far as it still reproduces
```

If you cannot share the code, `flowlens scan <path> --json` output with paths
redacted is usually enough.
