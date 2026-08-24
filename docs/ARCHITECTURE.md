# Architecture

## The one idea

The unit of the graph is not a **file**. It is a **feature execution**.

Codebase-visualisation tools draw file and module dependency maps. Those are
already a crowded category, and they answer a question developers rarely ask.
The question they _do_ ask is "what happens when I click this?" — so the graph is
built out of the steps of one execution: an action, a handler, some state, a
request, a route, a controller, a service, a query, a collection.

## Five engines

```text
                    FlowLens
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
 Static Analyzer   Runtime Tracer   Dependency Engine
       │               │                │
       └───────────────┼────────────────┘
                       ▼
                  Graph Engine
                       │
                       ▼
                 Visualization
```

| Engine             | Package                    | Job                                    |
| ------------------ | -------------------------- | -------------------------------------- |
| Static analyzer    | `core/analyzer`            | Read source, find the pieces           |
| File classifier    | `core/analyzer/classify`   | Frontend vs server, decided by content |
| File-system routes | `core/analyzer/fileroutes` | Next.js / Nuxt routing conventions     |
| Runtime tracer     | `runtime`                  | Record what actually ran               |
| Dependency engine  | `core/impact`              | Walk the graph backwards               |
| Graph engine       | `core/graph`               | Hold it, traverse it, serialise it     |
| Visualization      | `apps/dashboard`           | Make it legible                        |

## Scan pipeline

`scan()` in `packages/core/src/scan.ts` runs four passes, and the order is the
design:

1. **Frontend pass** (`analyzer/frontend.ts`) — components, user actions,
   handlers, state, hooks, outbound HTTP calls.
2. **Backend pass** (`analyzer/backend.ts`) — controllers, routes, DTOs,
   services, dependency injection, Mongoose models, database operations.
3. **Seam pass** (`analyzer/seam.ts`) — join the two. Until this runs there are
   two disconnected islands.
4. **Lineage pass** (`analyzer/seam.ts`) — follow individual fields:
   `state.diagnosis → payload.diagnosis → CreateRxDto.diagnosis →
prescriptions.diagnosis`.

Passes 1 and 2 build islands; pass 3 is where the product exists. Pass 4 can
only run after 3, because a field's destination is on the far side of the seam.

## Why AST, not regex

Everything reads syntax trees through `ts-morph`. A regex can find
`axios.post(` but cannot tell you which handler encloses it, which component
declared that handler, or which state variables the handler touches — and
enclosure is the whole product.

Deliberate choices in `analyzer/project.ts`:

- **No tsconfig required.** Real repos have three tsconfigs, a JS-only frontend
  and a broken build. FlowLens walks the file system itself.
- **No type checking** (`noLib: true`). We need shapes, not types. This is the
  difference between a scan that takes half a second and one that takes a
  minute.
- **Never execute the project.** Reading is safe; importing a stranger's config
  file is not.

## Matching the seam

`analyzer/http.ts` is the highest-leverage file in the repo: every backend
finding hangs off correctly matching one string to another.

```text
frontend:  api.post(`/api/patients/${id}/archive`, body)
backend:   @Controller('patients') + @Patch(':id/archive')
```

Both sides normalise to `/patients/:param/archive`, then match segment by
segment. Scoring is asymmetric on purpose:

| Call segment | Route segment | Score | Why                                          |
| ------------ | ------------- | ----- | -------------------------------------------- |
| literal      | same literal  | +3    | exact                                        |
| `:param`     | `:param`      | +2    | aligned                                      |
| literal      | `:param`      | +1    | route generalises                            |
| `:param`     | literal       | −1    | speculative — the frontend interpolates here |

That last row is why "prefer the most literal route" is wrong:
``api.get(`/patients/${id}`)`` should resolve to `GET /patients/:id`, not to
whatever fixed sub-route happens to sit at the same depth.

Unmatched leftovers are findings, not failures:

- a frontend call with no route → typo, or a method mismatch (`PUT` vs `PATCH`)
- a route with no caller → dead endpoint, or a caller outside this repo

### Prefixes must be stripped on both sides

`--api-prefix` applies to frontend URLs _and_ backend routes. This sounds
pedantic and is not: pointed at a production app whose controllers are declared
`@Controller('api/users')` while its frontend calls `/api/users`,
stripping one side only produced **506 routes, 199 calls, zero matches**. A
scanner that finds everything and connects nothing is worse than useless,
because the output looks plausible.

## Reading URLs the way real code writes them

The first version of this analyzer found 12 API calls in a frontend with roughly
500 of them. Nothing was wrong with the graph, the seam, or the flows — the
input layer simply did not recognise how the code was written. Three additions
took it from 12 to 199, of which 192 matched a route.

### 1. Endpoint constants (`analyzer/constants.ts`)

Real frontends keep paths in a module, not at the call site:

```js
export const getUsersList = '/api/users'; // src/config/endpoints.js
getRequest({ url: getUsersList }); // 200 call sites
```

`collectConstants` builds a project-wide name → literal table before either
analyzer runs, and `readPathLike` consults it — including inside template
interpolations. It is name-keyed rather than scope-aware, because proper import
resolution is exactly what `loadProject` skips for speed. A name declared twice
with different values is marked ambiguous and skipped: refusing to answer beats
inventing a route.

### 2. Wrapper functions (`readWrapperCall`)

Almost every team wraps HTTP in a house helper family:

```js
getRequest({ url, auth, params });
patchRequestNoLoader({ url, body });
getRequestV3({ url });
```

The verb is in the _name_ and the path in an options object. The default pattern
requires `Request` after the verb, which matters more than it looks: a looser
`^(get|post|delete)` would swallow `getState()`, `getPatientsList()` and
`deleteRow()` and fill the graph with endpoints that do not exist.

A `params` suffix is appended only when it extends the path (`` `/${id}` `` →
a different route); a query string (`?from=x`) is dropped, because it is the
same route.

### 3. Interpolated base URLs

```js
axios.get(`${baseUrl}${endpoint}?from=${date}`);
```

A leading interpolation is a host, not a path segment. Without stripping it,
every call in a codebase collapses to `/:param/:param` — which is what the first
real-world scan produced. Only the first is removed, so a genuine
`/:tenantId/...` route keeps its parameter.

## Multi-root scanning

A frontend and backend usually live in sibling repositories, and the seam
between them is the product. `scan({ root, extraRoots })` loads several trees
into one graph and labels each file by its root (`my-web/pages/index.js`),
which keeps ids unique and tells the reader which repo they are looking at.

Scanning every consumer of an API at once also sharpens the findings: a route
that looks dead against one frontend may simply be called by the mobile app.

A consequence worth knowing: `api-call` nodes are keyed by method and path, so
two frontends calling the same endpoint converge on one node. That is what makes
impact analysis span both of them.

## Telling frontend files from backend files

The frontend pass must skip server code, or the backend's own outbound HTTP
requests become "API calls" and invent flows. The obvious approach — look at the
path — is wrong, and was a real bug: treating anything under `api/` as backend
silently discarded every call in a frontend that kept its HTTP client in
`src/api/`, which is an extremely common layout.

So `analyzer/classify.ts` reads the file instead, in order of how much each
signal can be trusted:

1. **File-system route conventions** (`pages/api/**`, `app/**/route.ts`,
   `server/api/**`) — server, wherever they sit.
2. **Framework decorators** (`@Controller`, `@Injectable`, `@Schema`) — server.
3. **JSX** — frontend, even if the file also imports a helper that talks to a
   database. The rendering is the part that matters.
4. **Imports** — `@nestjs/*`, `express`, `mongoose`, `node:*` mean server;
   `react`, `next/*`, `vue` mean frontend. A client import wins a tie, because
   `react` plus `node:crypto` is a hook that hashes something.
5. **Class naming** (`*Controller`, `*Service`) — a last resort.

Anything with no signal at all is `shared` and read by both passes, which is
harmless: a constants module yields no components and no routes.

## Following a call into the service layer

Not every request is made where the button is. A very common shape is:

```ts
// src/api/patients.ts
export async function fetchPatients() {
  return axios.get('/api/patients');
}

// src/components/List.tsx
const handleLoad = async () => setRows(await fetchPatients());
```

`fetchPatients` is not a hook, not a component, and not named `handle*`, so an
earlier version had nothing to attach the request to — the chain stopped at the
handler and the API call floated free.

Every top-level function is now a _lazily declared_ symbol: the graph node is
created only when the function turns out to make a request or to be called by
something that does. Whatever is left — ordinary helpers calling each other —
is pruned by `pruneUnusedModuleFunctions`, which drops any module function that
cannot reach an `api-call`. The result follows real code without filling the
graph with utilities.

## Robustness

FlowLens is pointed at whatever a developer has on disk, so the file walk assumes
nothing:

- **Symlinks** are resolved with `realpath` and visited once. A `self -> .` or
  `parent -> ..` link is ordinary in deploy trees and would otherwise spin
  forever; dangling links are skipped.
- **Per-file isolation.** Both analyzers wrap each file in a try/catch and
  collect failures as warnings. A syntax error in one component must not cost
  the other 9,999 files.
- **Bounded work.** A depth cap, a per-file size cap, a `--max-files` valve, and
  a skip list of roughly thirty generated directories.
- **Degenerate inputs** are all defined behaviour: an empty directory, a single
  file as the root, a directory containing only `node_modules`, a read-only
  project (the graph falls back to the current directory), overlapping roots
  (deduplicated), and roots sharing a basename (labelled by their parent).

One deliberate omission: the symlink-cycle fixture is built in a temp directory
at test time rather than committed. A real cycle on disk breaks every other tool
that walks the tree — including the test runner, which is how we found out.

### Phantom endpoints

A subtle one, found by auditing rather than by a failing test. The _definition_
of a request wrapper contains a genuine HTTP call whose URL is a parameter:

```js
export const getRequest = ({ url, params }) =>
  axios.get(`${baseUrl}${url}${params}`); // -> GET /:param
```

Every wrapper in the family therefore added an endpoint like `GET /:param`. Not
merely cosmetic: they inflated the API-call count, appeared in `doctor` as broken
calls, and a path of pure parameters can match a real `/:id` route and invent a
flow. `isConcreteEndpoint` now requires at least one literal segment — unless
the path was written as a literal, so a hardcoded `axios.get('/')` survives.

### Failing fast on configuration

An invalid `--request-fn` regex used to throw inside the per-file try/catch of
every file. The scan completed, reported zero API calls, and buried the real
reason in warnings — which reads as "my project is unsupported" instead of "you
mistyped a regex". Patterns are validated once, before any file is read.

## Evidence, not diagrams

Every node and edge carries `static | runtime | confirmed`.

```ts
mergeEvidence('static', 'runtime') === 'confirmed';
```

A flow reports its **weakest** link, because a chain with one inferred hop is an
inferred chain no matter how much runtime data surrounds it.

Runtime-only discoveries are **added** to the graph rather than discarded. A
query the analyzer never found is the most interesting thing a trace can tell
you.

## Timing: inclusive vs exclusive

Traces are nested, so timings come in two flavours and only one of them can be
summed:

```text
POST /prescriptions   (api-call)   196ms inclusive   171ms self  ← network
POST /prescriptions   (route)       150ms inclusive    34ms self  ← framework
PrescriptionsService.create         140ms inclusive    60ms self  ← logic
  patients.findById                  27ms inclusive    27ms self
  prescriptions.create               41ms inclusive    41ms self
```

`selfTimeOf()` subtracts direct children from each span. Adding inclusive times
counts the same milliseconds once per level of nesting — the first version of
this reported a 204ms request as 995ms.

## Risk scoring

`scoreRisk()` is intentionally simple and fully explained: every point comes
with a sentence in `reasons`. Writes, destructive operations, fan-in on shared
methods, collection count, and unmatched calls add; runtime confirmation
subtracts.

A developer who disagrees with the number should still learn something from the
reasons. A score nobody can audit is a score nobody trusts.

## Adapters, not special cases

Framework knowledge is isolated:

```text
analyzer/frontend.ts   React/Next + HTTP clients
analyzer/backend.ts    NestJS decorators, Express routers, DI
analyzer/mongo.ts      Mongoose operations, collection naming
```

Adding Prisma means a new `analyzer/prisma.ts` emitting the same `db-op` and
`collection` nodes. Nothing downstream — flows, impact, lineage, dashboard —
changes.

## Known limits

Honest boundaries, because a static analyzer that claims completeness is lying:

| Limit                                         | Effect               | Mitigation                         |
| --------------------------------------------- | -------------------- | ---------------------------------- |
| A wrapper's own definition                    | Skipped, not counted | `isConcreteEndpoint`               |
| Fully dynamic URLs (`api[method](path)`)      | Call missed          | Runtime tracing                    |
| Unconventional HTTP wrappers                  | Call missed          | `--request-fn`, `--http-client`    |
| Constant declared twice with different values | Skipped, not guessed | Rename, or `--no-constants`        |
| Cross-file name collisions                    | Ambiguous resolution | Same-file wins, then unique global |
| Handlers passed through props                 | Action has no path   | Runtime tracing                    |
| Dynamic collection names                      | Collection missed    | Runtime tracing                    |
| Queues, cron, websockets                      | Not modelled         | Roadmap                            |

On the production app measured above, 998 user actions produced 37 flows. That
ratio is honest rather than disappointing: most clicks toggle local state, and
many handlers arrive through props from a parent several files away. Static
analysis can prove the 37; the browser tracer is what finds the rest.

Every one of these is a case where static analysis is genuinely insufficient,
and each is exactly what the runtime tracer exists to cover. Neither half is
complete alone; that is the design, not a defect.
