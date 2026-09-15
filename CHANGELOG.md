# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Two more tabs, and the Breaks tab now separates findings from wallpaper.**
  Measured against a real 132-flow project, the first version had two problems
  worth fixing before adding anything: `useToast` was the single most-flagged
  "shared step" in the whole graph (13 features, because they all show a toast),
  and "Medicines · Delete" appeared twice in the same list with no way to tell
  the two apart.

  - **Shared by design versus shared by accident.** A toast hook, a cache, a
    logger, an audit trail and route middleware are shared _on purpose_ — that
    is what infrastructure is. They now sit in their own collapsed section with
    the reason they were demoted, and they no longer count toward "features that
    could break". Two independent signals decide it: a name list for the obvious
    cases, and _ubiquity_ — a step used by more than a third of the project's
    features is a platform utility whatever it is called, which is knowable from
    the graph rather than from a vocabulary. On the same project this moved
    high-risk features from 16 of 132 to 3, and the top of the findings list from
    `useToast` to `GET /medicines`.
  - **Colliding feature titles get a distinguishing suffix** (`Medicines ·
Delete · MedicinesView`), and only when they collide.
  - **"Why this level"** discloses the factors behind the verdict, for the same
    reason the CLI lists its risk factors: a score nobody can audit is a score
    nobody trusts.

- **A `Changed` tab: what your uncommitted edits put at risk.** The other tabs
  start from a feature and work outwards; this one starts from the diff, which
  is where a developer actually is — mid-change, about to commit, wondering
  whether four touched files reach further than they meant. `git status` crossed
  with the graph gives the features that run through those files, ranked by how
  much of each one the diff touches, and which of them have no test at all:

  ```text
  high risk   1 changed file is used by 5 features; 5 of them have no test.
  ```

  It is the one new view that works from the first minute: unlike Timing it
  needs no instrumentation, and unlike Tests it says something useful on a
  project with none. Changed files with no node in the graph are listed as such,
  because a stylesheet or a config Flowslens does not model can break things
  this cannot see. Matching is by file rather than by changed line, which
  over-estimates on purpose — narrowing it would trade a false alarm for a false
  negative, the wrong direction for a view whose job is to ask "are you sure?".

- **A request that waits on React state is now part of the sequence.** The
  chain source order cannot see:

  ```jsx
  useEffect(() => {
    api.get('/orders').then(setOrders);
  }, [user]); // waits for `user`
  useEffect(() => {
    api.get('/me').then(setUser);
  }, []); // …which this sets
  ```

  The effect that waits is idiomatically written _above_ the fetch it depends
  on, so reading top-to-bottom gives the wrong answer. Flowslens now reads both
  ends — the `useEffect` dependency array, and the state a call's result flows
  into (`.then(setUser)`, `setUser(result)`, or a query hook's `data:` binding)
  — pairs them up, and reorders so a producer always precedes its consumer.
  `GET /me` is reported first even though it is written second.

  It is phrased differently from a direct dependency on purpose: _"re-runs when
  the state set by GET /me arrives"_. That is what actually happens, and it is a
  weaker promise than reading a response — the effect fires on a later render,
  and fires again every time that state changes. The panel says so.

  An empty dependency array is reported as "sent once, when the screen loads"
  rather than lumped in with the rest.

- **A component that loads its data through `useEffect` now gets a mount
  action.** It had none: the mount pass looked for functions the component
  calls, and `useEffect(() => { api.get('/me') }, [])` produces no intermediate
  function — the request hangs off the component itself. So for a component of
  that shape, the entire screen's data loading was missing from the feature
  list. Restricted to calls inside an effect, because a request written directly
  in a render body is a bug rather than a feature and should not be described as
  one.

- **An action that makes several requests is now shown as a sequence.** All the
  calls were always _found_; what was missing was any way to tell three very
  different shapes apart, because every one came out at the same depth in
  whatever order the scan happened to read them:

  ```js
  const cart = await api.get('/carts/current'); // then
  const order = await api.post('/orders', { cartId: cart.id }); // …this, which needs it

  api.post('/coupons/validate').then(() => api.put('/carts/current')); // only if that resolved

  await Promise.all([api.get('/medicines'), api.get('/clinics')]); // both at once
  ```

  Requests are now numbered in source order and each one says when it happens:
  `needs the response from GET /carts/current`, `only after POST
/coupons/validate resolves`, `sent at the same time as GET /clinics`.

  - The waiting relationship is read from the **data**, not from line order: an
    earlier call bound its result to a variable and this call's arguments
    mention it. Two independent awaited calls are reported as first and second
    without claiming one needs the other.
  - A `.then` chain is reported separately as a _control_ dependency, because
    the inner call cannot run at all unless the outer resolved — whether or not
    it reads the response.
  - `Promise.all` members are reported as concurrent, and the tab says plainly
    that calls fired without awaiting may finish in either order. That is the
    code's behaviour, not a gap in the reading, and implying a sequence there
    would be inventing one.
  - Facts are collected per call _site_ and recorded on the `requests` edge: one
    `api-call` node stands for an endpoint and may have many sites, while "which
    one runs first" is a fact about a site.

- **An `APIs` tab: the seam in full.** The flow view showed a request as two
  tiles, which is right for the shape of a chain and wrong for the questions
  people actually have at the seam. Answering "what does this endpoint do and
  who depends on it" took six clicks around the graph; it is now one read, per
  request:

  - the URL as written in the frontend (before any prefix was stripped), the
    client or wrapper that sends it, and every call site;
  - the body: each key, the state it is built from, and whether the route
    declares it;
  - the route, its framework, its controller and the file that declares it;
  - the guards, pipes and middleware that run _before_ the handler and can stop
    the request;
  - the code the request runs and every collection it reads or writes, with the
    operation, the effect and the method that issues it;
  - work that leaves the app on that request;
  - **who else calls the same endpoint** — a route with four callers is not
    yours to reshape, and that is invisible from the handler;
  - a copyable `curl`, with `:param` placeholders left alone rather than filled
    with an invented id.

  The payload-versus-DTO check moved in here rather than having a tab of its
  own, because agreeing about a body is a fact about an endpoint. It still needs
  a declared shape — NestJS DTO classes today — so a route with no DTO reports
  "no DTO to check" rather than being counted as agreeing, and a body built from
  a variable rather than an object literal is reported as unreadable rather than
  as absent: `api.post(url, payload)` leaves nothing to enumerate at the call
  site, and silence there would read as "sends nothing" in the one place
  somebody is checking what it sends.

- **Everything is clickable.** Every `file:line` in every tab opens your editor —
  `?editor=vscode` by default, with `vscode-insiders`, `cursor`, `windsurf`,
  `idea`, `webstorm` and `zed` available. In a terminal `file:line` was already
  clickable; in the browser it was plain text, which made the dashboard worse
  than the CLI at the very next thing a developer wants to do. Clicking a shared
  step opens it in the existing details sidebar, and the Tests tab shows a
  copyable `npx vitest run …` for just the tests that cover the open feature —
  shown rather than run, because Flowslens does not execute anything in the
  project it reads.

- `analyzeImpact` takes an optional pre-resolved flow list. Asking it about
  every step of a feature re-resolved every flow in the project per step, which
  was quadratic on exactly the large projects worth asking about.

- **The dashboard asks four questions about a feature, not one.** The flow view
  answered "what happens when a user does this". On its own it is quietly
  misleading: it shows a chain as though it belonged to this feature, when most
  of the chain is shared. Editing `CustomersService.findOne` because one screen
  needs an extra field is a five-minute change that breaks four other screens,
  and nothing in the view hinted at it, because every step looked equally yours.

  Each tab carries its own headline number, so the worrying one is visible
  before it is opened — `Breaks · 3` and `Tests · none` are the two that change
  what a developer does next.

  - **Timing** — how long each step took, from runtime spans, ranked by the
    step's _own_ time. Totals come from the widest inclusive measurement rather
    than by adding steps up, because summing nested spans counts the same
    millisecond once per level and reports a flow as several times slower than
    it was. With no spans it renders the three steps needed to get them rather
    than a zero, and it never estimates: an invented number in a performance
    view is worse than no number, because it gets quoted.
  - **Breaks** — the same steps split into "shared with other features" and
    "only this feature uses", most-shared first, each with the file to open and
    the features it reaches. Plus collections written from more than one method,
    which is the failure static analysis is uniquely good at catching: two
    features writing the same collection with different assumptions, where
    neither author ever reads the other's code and nobody gets a compile error.
    Clicking a feature name jumps to it, staying on the tab.
  - **Tests** — which test files import the files this flow runs through, with
    their case titles, and which of the flow's files nothing imports. Coverage
    is counted in files rather than lines on purpose: the question is "would
    anything fail if I change this step", and a line percentage is a more
    familiar number and a worse answer to it.

  New in `@flowslens/core`: `analyzeFlowImpact`, `flowTiming`, `indexTests` and
  `testsForFlow`. New on the server: `GET /api/insight?flow=<id>`, which returns
  all three in one response — the tabs are read together, and three round trips
  would make switching tabs feel like loading a new page.

  Test coverage is read with fs and regular expressions rather than through the
  analyzer, and deliberately stays out of the graph vocabulary: test files are
  excluded from the scan (they would otherwise show up as components and routes
  in their own right), and the only facts needed are the titles and the imports.
  Only _relative_ imports count — a test importing `@flowslens/core` says
  nothing about which file it covers.

- **`flowlens stack` — "what is this project built with?"** The flow graph
  answered "what happens when I click this"; nothing answered the question that
  comes first. The signals were already in the tree and thrown away:
  `classify.ts` knows the server and client module lists well enough to sort
  files into frontend and backend, then discards the evidence.
  - Reads every `package.json` under the scanned roots (never `node_modules`)
    and reports frameworks grouped by what they are _for_ — frontend, backend,
    database, auth, state, jobs, realtime, testing, tooling — each with the
    version range as declared, because React 17 and React 19 are different
    projects.
  - Filesystem-only: no parse, no graph, no scan required. It works on a
    repository you cloned a minute ago, which is exactly when it is needed.
  - Reports a version disagreement between workspaces instead of hiding it. Two
    apps in one repo on different majors of React is the reason a shared
    component behaves differently in the two, and "first manifest wins" would
    have quietly picked one.
  - Says which parts of the detected stack it cannot trace, in three honest
    states: traced, **not traced yet** (Vue, TypeORM, GraphQL), and **traced to
    the hand-off** — a queue whose `add()` call is shown but whose worker is not
    read. A report that lists Vue without saying so is a report that
    overpromises, and the developer finds out after spending the afternoon.
  - Also reports the package manager from the lockfile that is really present,
    `engines.node`, the workspace layout, and marker files (`tsconfig.json`,
    `nest-cli.json`, `schema.prisma`, `docker-compose.yml`) that a dependency
    list does not mention.

- **Guards, middleware, interceptors and pipes are now steps in the flow.**
  `@UseGuards(JwtAuthGuard)` is the reason a request 401s and `requireAuth` in
  `router.post('/orders', requireAuth, create)` is the reason the same route
  needs a token — neither appears anywhere in the handler you are reading. Both
  were previously dropped: the Express pass explicitly took "the last
  function-ish argument" and discarded the rest, and Nest's decorators were only
  ever read for route verbs. That made the most common day-three question
  unanswerable, because "show me everything that happened when I clicked this"
  has to include the check that could stop it.
  - New `middleware` node kind and `guarded-by` edge, carrying the role (guard,
    interceptor, pipe, filter, middleware) and whether it was declared on the
    controller or the method — the class-level one being the one people forget.
  - Framework plumbing (`express.json()`, `cors`, `helmet`, `morgan`) is left
    out. Listing it on 200 routes buries the `requireAdmin` that matters.
  - Guards appear in the network layer of `flow`, the feature document and the
    dashboard, in the order the framework runs them.

- **Work that leaves the app is a visible terminal step instead of a silent
  stop.** A flow reaching `stripe.charges.create()` does not end there — it ends
  somewhere Flowslens cannot follow, and those are different statements. Before
  this, both looked identical: the chain stopped after the last collection, and
  a developer reading it would conclude that creating an order writes a row and
  nothing else.
  - New `external-effect` node kind and `emits` edge, for third-party HTTP,
    queued jobs, cache reads and writes, mail, object storage, socket emits and
    payment providers. Each one carries `unread: true`, so every consumer can
    say "Flowslens does not read what happens here" rather than imply the flow is
    complete.
  - Its own `LEAVES THE APP` layer, not the data layer: a payment provider
    listed under "DATABASE" is a wrong answer to the question that heading asks.
  - Only absolute URLs to hosts that are not this application count, so
    `localhost` and relative paths stay internal. Clients are matched by name
    _and_ method — `queue.add()` is a job, `array.add()` is not — and by
    distinctive suffix, so Nest's own `@InjectQueue('orders') ordersQueue`
    idiom is picked up.

- **Prisma is read: schemas, models, tables and operations.** The most common
  backend Flowslens could not follow. `prisma.order.create()` now produces the
  same `db-op` and `collection` nodes as Mongoose, because the question ("what
  data did this action touch?") does not change with the database.
  - `schema.prisma` is found and read from disk — it is not JavaScript, so it
    never reached the source-file list — including a Prisma 5 `schema/` folder
    and `@@map`. The table name is taken **literally**: applying Mongoose's
    pluralisation to a name Prisma took as written would name tables that do not
    exist.
  - Every client operation is classified by what it does (`findMany` read,
    `createMany` create, `updateMany` update, `deleteMany` delete), with
    `upsert` left as the honest vague `write` for the same reason as Mongoose's
    `save()`: which branch it takes is runtime state.
  - Requires a recognised client name _and_ a model the schema declares, which
    is what keeps `this.db.logger.info()` out of the data layer. A project with
    no schema on disk gets nothing rather than a guess.
  - Works in Nest services, Express handlers, Next route handlers and plain
    query modules, because it was added where the existing passes already
    attribute database work.

- **`actionProps` and `inputActionProps` config.** Every other convention was
  overridable — the HTTP client names, the request-wrapper pattern, the URL keys
  — and the action prop list was not, which made it the odd one out in the worst
  way. A design system whose button says `onAction`, or a table whose row says
  `onRowClick`, produced zero actions for those components with no recourse
  short of patching the package.

- **The tracer now runs against a live application** (`tests/live.test.ts`).
  Every previous tracer test drove the middleware and the sink directly, or fed
  the merge a span list written by hand — which proves the contract but cannot
  prove the integration, because a hand-written span is exactly the span the
  code under test expects. This boots a real `node:http` server with the real
  middleware in front of it, makes real requests over a real socket, lets the
  real sink write a real JSONL file, and merges that file into a real scan:
  `confirmed` evidence, observation counts, parent/child nesting, and durations
  that were measured rather than asserted. The Mongoose plugin is still driven
  by fakes — that needs a live database, and the suite runs with no server and
  no network of its own.

- **The dashboard's browser code has coverage** (`tests/dashboard.test.ts`).
  `app.js` is loaded the way a browser loads it, against the real `index.html`
  with `fetch` answering from a real scan, and the rendered DOM is asserted:
  layer order, per-layer colour classes, the flow list, escaping, and that a
  step is labelled by what it did rather than by its node kind. The labelling
  layer is where a wrong answer gets delivered confidently, so it is the part
  worth covering first.

- **New scan stats:** `middleware`, `externalEffects` and `prismaSchemas`, and a
  diagnostic for the case where a Prisma schema was read but no query matched it
  — almost always a differently named client, which beats an empty data layer
  that reads as "this project has no database".

- **`.gitignore` help for the artifacts you asked Flowslens to put in your
  repository.** By default there is nothing to ignore — the graph and the trace
  are written to the OS cache, not the project — but `-g graph.json`,
  `--trace`, and `$FLOWLENS_TRACE` all put a generated file inside a work tree,
  where it then shows up as an untracked change on every branch until someone
  remembers to delete it before pushing.
  - `scan` and `serve` keep those files out of `git status` by default. The
    alternative puts the cost on the wrong person: a developer who integrated a
    read-only dev tool should never have to discard its output before
    committing their own work, on every branch, forever. `--no-gitignore` (or
    `"gitignore": false`) restores report-only behaviour.
  - `flowlens init --gitignore` adds exactly those paths — not a block of
    speculative patterns — to a managed section of `.gitignore`, marked with
    `# flowlens:begin` / `# flowlens:end`. It is idempotent, leaves every line
    the developer wrote untouched, anchors each pattern with a leading `/` so
    `/graph.json` cannot also hide a `src/graph.json`, skips anything the
    project already ignores, and reports files that are already committed
    (where `git rm --cached` is the actual fix). It works on an
    already-configured project, leaving the config alone, and writes nothing
    under `--print`.
  - `"gitignore": true` in `flowlens.config.json` opts a project in for
    everyone, so the block stays current on every scan; `--gitignore` /
    `--no-gitignore` override the config for one run.
  - 21 new tests, against real git repositories in a temp directory.

### Changed

- **The round trip is no longer half-described.** Every view stopped at the
  database; what happened _after_ the response landed was invisible. Three
  additions, all read from the handler or hook that deals with the response:

  - **`What comes back`** per request: the status codes the endpoint has really
    answered with (recorded from runtime spans, which previously kept only
    durations) and the React state the response lands in. The response _shape_
    is still not read — the handler's return value is ordinary code and typing
    it would be guesswork.
  - **`After the response`**: where the action navigates, what the user is
    shown on success and on failure, and whether anything catches a rejection
    at all. A feature with no `catch` now says so, because an unhandled
    rejection is a different outcome from an error message.
  - **Cache invalidation followed to the refetch it causes.** This is the
    continuation no amount of reading the handler reveals:
    `invalidateQueries({ queryKey: queryKeys.medicines.all })` fires fresh
    requests from components you are not looking at. Reading it needed two
    fixes beyond the obvious one — after-effects are collected from **hooks**
    as well as handlers, because `useMutation({ onSuccess })` inside a custom
    hook is where a React Query app actually keeps its invalidation; and key
    **factories** are read as written (`queryKeys.medicines.all`) rather than
    only literals, since a real project has no literal keys. On the pharma
    project this went from 0 flows to 8. Keys are paired to endpoints by name,
    on a path segment, and the panel says so — the alternative is reading key
    factories, which are ordinary functions and can be anything.

- **The APIs tab was unreadable at the widths it actually renders at.** The
  sections were laid out with `auto-fit, minmax(270px)`, which on a wide screen
  produced four cramped columns — and a four-column data table inside a 270px
  column broke words down the middle: `updat`/`e`, and a file path split across
  five lines. More columns is not more information.
  - Two columns at most, and tables and path lists span the whole card.
  - File references show `user-store.ts:127` with the full path in the tooltip
    and in the link. The basename and the line are what identify a place; the
    directory prefix was the least useful half of the string and the half doing
    the wrapping.
  - Words break between words and never inside one; chips, table cells and the
    `curl` line refuse to reflow, and the one long column truncates with an
    ellipsis instead.

- **Flowslens output stays out of `git status` by default.** Previously `scan`
  and `serve` printed a note and left the repository alone, on the principle
  that a tool asked to read a project does not get to edit it. That principle
  is right about source files and wrong about this one case: the artifact is
  Flowslens's own, it appears as an untracked change on every branch, and the
  developer pays for it on every commit until they remember the flag.

  What keeps editing `.gitignore` defensible is how narrow it is:

  - Only files Flowslens itself writes, and only when they are inside a work
    tree. In the default setup the graph and trace live in the OS cache, so
    there is nothing to add and `.gitignore` is never opened at all.
  - Only Flowslens's own `# flowlens:begin` block is rewritten; every line the
    developer wrote is preserved byte for byte, and re-running changes nothing.
  - `flowlens.config.json` is never ignored. It is the project's own
    configuration, meant to be committed so the whole team gets the same graph.
  - Each addition is printed (`gitignore: added /graph.json … — Flowslens
output stays out of your commits`). A tool that writes silently is a tool
    you stop trusting the moment you notice.
  - `--no-gitignore` and `"gitignore": false` keep the old report-only
    behaviour.

  `init` is deliberately unchanged and still needs an explicit `--gitignore`:
  for that command the flag also selects a mode, where asking for the ignore
  step is what turns "this config already exists, use --force" from an error
  into the one job left to do. Defaulting it on would have quietly removed a
  guard rail that stops an edited config being replaced.

  The `--help` footer no longer claims that nothing is written into the project
  you scan, because `.gitignore` now can be. It says which file, when, and how
  to turn it off.

- **The display name is `Flowslens` everywhere.** Previously the product called
  itself "FlowLens" in prose while publishing as `@flowslens`, so the two
  spellings sat side by side in the README, the `--help` output, every error
  message and the dashboard's title bar.

  What did **not** change, because these are identifiers rather than a brand:
  the `flowlens` command, `flowlens.config.json` and `.flowlensrc`, the
  `FLOWLENS_*` environment variables, the `# flowlens:begin` marker token, the
  `.cache/flowlens` path, and the `@flowslens/*` package names.

  - `FlowLensConfig` is now `FlowslensConfig`, with the old name kept as a
    deprecated alias — it is exported, so removing it would break 1.0 callers
    for a rename that costs them nothing to ignore.
  - **`.gitignore` blocks written by 1.0 are recognised and upgraded in place.**
    The marker's parenthetical is part of a line written into the user's
    repository, and the block was located by matching that line exactly. Left
    alone, every already-configured project would have gained a _second_
    managed block and kept the orphaned first one forever. The block is now
    found by the `# flowlens:begin` token, which was never meant to change, and
    a stale marker is itself reason enough to rewrite.
  - `flowlens.cmd` keeps its CRLF line endings, which a repo-wide rewrite would
    otherwise have normalised to LF — `cmd.exe` mis-parses a batch file without
    them, and it is the Windows entry point.

- **Every development dependency updated to its latest release**, with one
  deliberate exception:

  | Package           |  From  |   To    | Note                                |
  | ----------------- | :----: | :-----: | ----------------------------------- |
  | typescript        | 5.9.3  |  6.0.3  | 7.0.2 exists; see below             |
  | vitest            | 4.1.11 |  5.0.0  | Raises the test runner's Node floor |
  | jsdom             | 26.1.0 | 30.0.1  | Same                                |
  | eslint            | 10.8.1 | 10.10.0 | Two new rules, four real findings   |
  | @eslint/js        | 9.39.5 | 10.0.1  | Aligned with eslint 10              |
  | @types/node       | 24.13  | 26.5.1  |                                     |
  | typescript-eslint | 8.67.0 | 8.70.0  |                                     |
  | globals           | 17.11  |  17.12  |                                     |

  `ts-morph` (the only runtime dependency) was already current at 28.0.0.

- **TypeScript is held at 6.0.3, not 7.0.2.** Not caution: `typescript-eslint`
  declares `typescript: >=4.8.4 <6.1.0` and throws
  `typescript-eslint does not support TS 7.0` on load, which takes the entire
  lint step with it. TypeScript 7 compiles this project without a single error,
  so the upgrade is a one-line change the day typescript-eslint supports it.

- **ESLint 10.10 added `no-useless-assignment` and `preserve-caught-error`**, and
  both found real problems rather than style nits. Three `throw new Error(...)`
  sites in `config.ts` and `scan.ts` discarded the error that caused them, so a
  malformed config file or a bad `--request-fn` regex reported Flowslens's
  message with no way to see the underlying parse failure. They now pass
  `{ cause: error }`.

- **The CI test matrix drops Node 20**, which reached end-of-life in April 2026
  and which neither Vitest 5 (`^22.12 || ^24 || >=26`) nor jsdom 30 will run on.
  This says nothing about what Flowslens supports: `engines` is still `>=18.18`,
  and that claim is still proven by the `compat` job, which builds the packages
  and drives the CLI on 18.18 — verified locally on Node 18.20.8 as well.

- `Array.prototype.findLastIndex` replaces a hand-rolled helper in the Express
  route pass. The comment justifying the helper was wrong: the project compiles
  against `lib: ES2023`, which declares it, and Node 18 has had it since day
  one.

### Security

- **`flowlens serve` sent `Access-Control-Allow-Origin: *` on every JSON
  response**, so while the dashboard was open, any page in your browser could
  read `/api/graph` — every absolute file path, route, DTO field and collection
  name in the project — and send it anywhere. Binding to `127.0.0.1` was no
  defence: a browser is already on this machine. The wildcard now appears only
  on the span endpoints, which need it and return `{ok:true}`.
- **`POST /api/rescan` was reachable cross-origin.** With `content-type:
text/plain` it is a CORS simple request, so no preflight stood in the way and
  no readable response was needed to make it worth doing — a page could pin a
  core re-scanning a large project. `/api/*` now rejects any request carrying a
  foreign `Origin`.
- **`POST /__flowlens/spans` accepted spans from anyone.** Forged spans merge
  into the graph as `confirmed` evidence, which is precisely the claim Flowslens
  makes that nothing else does, and the trace file grew without limit. The
  endpoint now requires a token, generated per run and printed as part of the
  URLs to copy (`--token` / `$FLOWLENS_TOKEN` to fix it), and the trace file
  stops at 64 MB with a warning rather than filling the disk.
- **No `Host` header validation** left the server open to DNS rebinding, which
  defeats every same-origin rule above. Requests must now be addressed by IP
  literal or `localhost` — the two things an attacker cannot rebind.
- **`--host` exposed everything above to the network silently.** A non-loopback
  bind now requires the token for the whole API and prints a warning saying
  what it has done. The dashboard passes on the token it was opened with, so
  the printed URL just works.
- **A `flowlens.config.json` is discovered by walking up from the scanned
  path**, so an unfamiliar repository could choose its own scan settings.
  `roots` pointing outside the project now produce a warning naming the
  directory, and `requestFunctionPattern` is length-capped before compilation
  and matched only against plausible identifiers — bounding what a hostile
  pattern can cost. The pattern is also compiled once instead of once per
  member expression, which was a real cost on a large frontend.
- 21 new tests: the rules as functions, and the attacks themselves replayed
  against a live `flowlens serve`.

### Fixed

- **Conditional and error-path requests were reported as a sequence.** Two calls
  in opposite arms of one `if` came out as "sent first" and "sent second", and a
  call in a `catch` as "sent third". All three were wrong, and wrong in the way
  that gets believed: it read as "this action makes three requests" when the
  action makes one.

  ```text
  before                              after
  1. PUT  /medicines/:param  first     1. PUT  /medicines/:param  only when isEdit — otherwise POST /medicines
  2. POST /medicines         second    1. POST /medicines         only when not isEdit — otherwise PUT /medicines/:param
  3. POST /errors            third     2. GET  /medicines         sent second
                                       3. POST /errors            only when the request fails
  ```

  Alternatives now share a step number and are joined with `or` rather than an
  arrow; the call after a branch is numbered second rather than third; and a
  `catch` request is marked as an error path. `if`/`else`, ternaries, `switch`
  cases and `finally` are all read, and a condition beats every ordering phrase
  because "sent second" is false for a call that may not be sent at all.

- **`packages/cli` was type-checking and running against the _published_
  `@flowslens/core` 1.0.0**, not the local workspace: a stale
  `packages/cli/node_modules/@flowslens/core` left over from an earlier install
  shadowed the workspace link, so any new core API was invisible to the CLI
  build. The lockfile never referenced it; removing the directory restores the
  intended link.

## [1.0.1] - 2026-09-09

**A documentation release, and an important one.** The READMEs published with
1.0.0 still named the pre-rename `@flowlens` scope, so all three npm pages told
readers to run `npx @flowlens/cli` — a package that does not exist. Anyone who
copied the install command off npm got "package not found". The package
manifests were renamed for 1.0.0; the READMEs inside the tarballs were not.

No runtime behaviour changes, apart from the `--version` and `--help` fixes
below.

### Fixed

- **`flowlens --version` reported `0.1.0` while the published packages were
  `1.0.0`.** The version was a literal in `packages/cli/src/index.ts`; it is now
  read from the package manifest, and a test asserts the two agree.
- **The scope rename to `@flowslens` was applied incompletely**, which left the
  repository in a state where `npm test` and `npm run test:package` both failed:
  - `tests/tracer.test.ts` still imported `@flowslens/runtime`'s old name, so the
    whole suite failed to load — 26 tests never ran.
  - `scripts/package-test.mjs` looked for `flowlens-*.tgz` tarballs and a
    `node_modules/@flowlens` directory that `npm pack` no longer produces. It now
    derives the scope from `packages/cli/package.json` rather than hardcoding it.
  - The remaining stale references were in the runtime and CLI help text, the
    example app's tracer wiring, and the docs.
- **`npm run lint` failed with 43 errors on any checkout where `prepack` had
  run.** `packages/cli/dashboard/` and `packages/cli/runtime/` are generated
  copies, gitignored but not ignored by ESLint, so browser globals in the copied
  dashboard were reported as `no-undef`. They are ignored now; the originals are
  still linted where they live.

### Documentation

- **`flowlens --help` advertised the wrong defaults.** It said the graph and
  trace default to `<project>/.flowlens/…`, which is where they went before
  1.0.0 — the opposite of the guarantee the tool is built on. The closing note
  said runtime tracing "writes to a local `.flowlens/trace.jsonl` in your own
  project", which is also no longer true. Both corrected, and `FLOWLENS_CACHE`
  and `FLOWLENS_TRACE` are now listed under ENVIRONMENT.
- **The published `@flowslens/runtime` README documented `traceMethod`
  incorrectly.** It showed `traceMethod('OrdersService.create', fn)` returning a
  wrapped function. The real signature is
  `traceMethod(className, methodName, fn, options?)` — it is `async` and wraps a
  _call_, so the documented form threw `TypeError: fn is not a function`.
- The npm READMEs for all three packages were rewritten for a first-time
  reader: what each one is for, whether you need it, install, then a numbered
  path to a working result.
  - `@flowslens/cli` now opens with **"will this work on my project?"** — a
    reads/does-not-read table — because installing a tool that cannot see your
    stack is the most expensive way to find that out. It also gained a
    troubleshooting section for the failures people actually hit.
  - `@flowslens/runtime` gained copy-paste blocks per stack (Express CommonJS,
    Express ESM, NestJS, Next.js) rather than one generic snippet, and full
    option tables.
  - `@flowslens/core` gained a complete runnable first script and a
    fail-CI-on-findings example.
  - All three now state that the packages are **ESM-only**, and that
    `require()` throws `ERR_REQUIRE_ESM` on Node 18–22.11 while working on
    22.12+. Verified on 18.20, 24.18 and 26.5.
  - Every command and API example in them was executed against
    `examples/crud`. That caught `analyzeImpact` needing a node id rather than
    a symbol name, `resolveFlow` taking an entry node id rather than a flow id,
    `renderFeatureDocument` taking `(graph, flow)`, and the `scan` option being
    `requestFunctionPattern` rather than a shortened form.
- Stale `.flowlens/` paths corrected in the NestJS example's comments and in
  four source comments that told contributors the graph is written into the
  scanned project.

- Corrected claims that had drifted: the test count (200 → 305), the project
  status (`v0.1, pre-release` → 1.0.0 on npm), the roadmap's "not published"
  entry, the dashboard's line count, and the milestone numbering after 1.0.
- **`SECURITY.md` said output goes to a `.flowlens/` directory inside your
  project.** It does not, and has not since 0.1.0 — artifacts live in the OS
  cache. Corrected, with the per-platform paths.
- `packages/runtime/README.md` told users to pass `--trace .flowlens/trace.jsonl`,
  reintroducing the file-in-your-repo behaviour that 1.0.0 removed.
- Documented that **development requires Node 20+** even though the published
  CLI supports 18.18: Vitest 4 cannot start on Node 18, so `npm test` there dies
  with a `SyntaxError` about `styleText` rather than a useful message.
- Documented the naming split — packages are `@flowslens/*`, the command is
  `flowlens` — in the README, the CLI package README and the changelog.

## [1.0.0] - 2026-08-31

First published release. The theme is: point Flowslens at any project, on any
machine, and have the first command work — without leaving a mark on that
project.

### Packaging

- **Published to npm** as `@flowslens/cli`, `@flowslens/core` and
  `@flowslens/runtime`. `npx @flowslens/cli scan .` now works without cloning
  anything. Note the scope: the packages are `@flowslens/*` while the command,
  the config file and the cache directory stay `flowlens`.
- **`npm run test:package`** packs the real tarballs, installs them into a
  throwaway project and drives the result over HTTP. Every other check runs
  against the working tree, where the dashboard and browser tracer simply
  exist — so a published CLI once shipped neither while all of CI stayed
  green.

### Fixed

- **Most flows were invisible in any codebase that does not name its functions
  `handleX`.** Node creation was gated on `/^(handle|on)[A-Z]/`, so a function
  called `fetchBillingData` or `saveVoiceRx` had no node; `ownerOf` walked past it
  and credited the request to the whole component, severing the
  `ui-action -> handler -> api-call` chain that a flow is built from. Measured on
  a production Next.js frontend: 361 of 439 API calls (82%) were mis-attributed,
  and requests owned by a component fell from 257 to 33 once every named function
  inside a component got a node. `async function save() {}` declarations inside a
  component were invisible for the same reason and are now included.
- The default `requestFunctionPattern` only matched a verb at the _start_ of the
  name, missing whole wrapper families such as `crmPostRequest`,
  `AcmeGetRequest`, `postAiRequest` and `getAiRequest`. The verb may now appear
  anywhere in the name and is matched case-insensitively, which found 31 more
  endpoints in the same frontend.

### Added

- **`flowlens where <file>:<line>`** — the reverse lookup. `flow <id>` goes
  forward from a click; this starts at a cursor position and reports every
  user-visible feature whose execution path runs through it, with the endpoint,
  the collections in reach and the risk. Two details make it usable rather than
  merely correct: a line inside a function body resolves to the nearest
  declaration _above_ it and says how far, rather than silently answering a
  different question; and a match that is not itself on the execution path (a
  `useState` field, a DTO, a schema field) is followed one hop along the
  non-execution edges to a node that is — the same one-hop rule `StepDetail`
  uses, and for the same reason. A bare basename is accepted only when
  unambiguous, because every App Router project has a dozen `route.ts`.

- Components that load their data on mount now get a synthetic `loads` action, so
  effect-driven fetches appear in `flows` instead of being unreachable. Tagged
  `event: 'mount'` and `synthetic: true` to distinguish them from a real DOM
  event. Hooks are excluded — `const { create } = useCreate()` in a component body
  is a declaration, not a mount-time request.

### Changed

- **Flowslens output stays out of `git status` by default.** Previously `scan`
  and `serve` printed a note and left the repository alone, on the principle
  that a tool asked to read a project does not get to edit it. That principle
  is right about source files and wrong about this one case: the artifact is
  Flowslens's own, it appears as an untracked change on every branch, and the
  developer pays for it on every commit until they remember the flag.

  What keeps editing `.gitignore` defensible is how narrow it is:

  - Only files Flowslens itself writes, and only when they are inside a work
    tree. In the default setup the graph and trace live in the OS cache, so
    there is nothing to add and `.gitignore` is never opened at all.
  - Only Flowslens's own `# flowlens:begin` block is rewritten; every line the
    developer wrote is preserved byte for byte, and re-running changes nothing.
  - `flowlens.config.json` is never ignored. It is the project's own
    configuration, meant to be committed so the whole team gets the same graph.
  - Each addition is printed (`gitignore: added /graph.json … — Flowslens
output stays out of your commits`). A tool that writes silently is a tool
    you stop trusting the moment you notice.
  - `--no-gitignore` and `"gitignore": false` keep the old report-only
    behaviour.

  `init` is deliberately unchanged and still needs an explicit `--gitignore`:
  for that command the flag also selects a mode, where asking for the ignore
  step is what turns "this config already exists, use --force" from an error
  into the one job left to do. Defaulting it on would have quietly removed a
  guard rail that stops an edited config being replaced.

  The `--help` footer no longer claims that nothing is written into the project
  you scan, because `.gitignore` now can be. It says which file, when, and how
  to turn it off.

- **The display name is `Flowslens` everywhere.** Previously the product called
  itself "FlowLens" in prose while publishing as `@flowslens`, so the two
  spellings sat side by side in the README, the `--help` output, every error
  message and the dashboard's title bar.

  What did **not** change, because these are identifiers rather than a brand:
  the `flowlens` command, `flowlens.config.json` and `.flowlensrc`, the
  `FLOWLENS_*` environment variables, the `# flowlens:begin` marker token, the
  `.cache/flowlens` path, and the `@flowslens/*` package names.

  - `FlowLensConfig` is now `FlowslensConfig`, with the old name kept as a
    deprecated alias — it is exported, so removing it would break 1.0 callers
    for a rename that costs them nothing to ignore.
  - **`.gitignore` blocks written by 1.0 are recognised and upgraded in place.**
    The marker's parenthetical is part of a line written into the user's
    repository, and the block was located by matching that line exactly. Left
    alone, every already-configured project would have gained a _second_
    managed block and kept the orphaned first one forever. The block is now
    found by the `# flowlens:begin` token, which was never meant to change, and
    a stale marker is itself reason enough to rewrite.
  - `flowlens.cmd` keeps its CRLF line endings, which a repo-wide rewrite would
    otherwise have normalised to LF — `cmd.exe` mis-parses a batch file without
    them, and it is the Windows entry point.

- **Flowslens no longer writes anything into the project it reads.** The graph and
  any runtime trace used to land in `<project>/.flowlens/`, which meant that
  merely looking at a repository dirtied it. They now live in the OS cache
  directory, keyed by project path (`~/.cache/flowlens/<name>-<hash>/` on Linux,
  `~/Library/Caches/flowlens` on macOS, `%LOCALAPPDATA%\flowlens\Cache` on
  Windows). `git status` after a scan is empty. `-g` / `--trace` still override,
  and `scan` and `serve` print the path they used.
- `saveGraph`'s fallback for an unwritable destination was the **current
  directory**, which is usually the project being scanned — the one place it must
  not write. It now falls back to the temp directory, keeping the project key so
  two projects cannot overwrite each other's graph.
- The `@flowslens/runtime` sink defaulted to `.flowlens/trace.jsonl` relative to
  the traced app, putting a file in the user's repository. It now honours
  `$FLOWLENS_TRACE`, else the same machine-local cache path.
- `examples/crud/demo-trace.mjs` takes the output path as its first argument
  instead of writing inside the example project.

### Added

- `GET /__flowlens/browser.js` on the dashboard serves the browser tracer, so
  instrumenting a frontend no longer requires copying a file into it. Sent with
  `access-control-allow-origin: *`, since the traced app is always another origin.
- `FLOWLENS_CACHE` relocates the artifact cache wholesale — used by the test
  suite and the smoke test so neither writes into the developer's real cache.
- `flowlens init --print` writes the detected config to stdout instead of to the
  project. `init` remains the only command that creates a file in your project,
  and it now names that file explicitly in its output.

- `flowlens init` — detects what a project actually is and writes
  `flowlens.config.json`. Finds a monorepo's `web/`+`api/` pair, and finds the
  case where the frontend and backend are separate **sibling repositories**
  (`shop-web` next to `shop-api`), which is where the interesting seam lives.
  The config it writes uses relative, forward-slashed paths, so it survives a
  commit and a different operating system — and it makes `flowlens scan` work
  from any subdirectory of the project.
- A launcher — `./flowlens` and `flowlens.cmd` — that installs dependencies and
  builds on first use, then rebuilds only when the sources are newer. A fresh
  copy of the project now works with one command instead of three, which is what
  makes the USB-stick story true.
- `npm run smoke`: every CLI command, run for real as a process, in plain Node
  with no shell. CI runs it on Windows, macOS and Linux. It replaces a bash
  block in the workflow that could only ever prove Flowslens worked on Linux.
- An ASCII fallback for the flow trees, chosen automatically on a legacy Windows
  console and forceable either way with `FLOWLENS_ASCII` / `FLOWLENS_UNICODE`.
  Redirected output always keeps the Unicode version.
- `serve` opens a browser when you are at a terminal (`--open` / `--no-open`),
  and moves to the next free port when 4177 is busy and no `--port` was given.
- CI: the unit suite on Windows and macOS as well as Linux, plus a job that runs
  the launcher from a checkout with nothing installed.

### Fixed

- **Windows paths were silently ignored.** Only `/` counted as a path
  separator, so `flowlens scan .\my-app` or `C:\code\app` was mistaken for a
  flow id and the scan ran against the current directory without saying so. Path
  detection now understands both separators, drive letters, UNC paths and `~`,
  and for commands that take no argument of their own every positional is a
  path.
- `flowlens scan my-app` — a project named with no separator at all — scanned
  the current directory instead. It now scans `my-app`, and a path that does not
  exist is an error rather than a silent success.
- `flowlens scan -g <file>` ignored the flag and wrote to the default location,
  so the `flows -g <file>` that followed could not find the graph.
- `npm install` left the project unbuilt, so the first command a new user ran
  failed on a missing `dist/index.js`. It now builds via a `prepare` script, and
  when the build really is missing the CLI says what to run instead of throwing
  a module-resolution stack trace.
- `npm run clean` used `rm -rf`, which does not exist on a Windows shell.
- The same file reached through two roots was analyzed twice on Windows and
  macOS, where the file system is case-insensitive, producing duplicate nodes.
- The symlink tests failed on a default Windows install, where creating a
  symlink needs Developer Mode; they are now skipped there rather than failing.
- The CLI checks the Node version and says so, instead of failing with a syntax
  error on an old runtime.

## [0.1.0] - 2026-08-24

First working version. Static analysis is verified against a production
codebase; runtime tracing is implemented but not yet exercised against a live
application (see `docs/ROADMAP.md`).

### Added

- **Graph engine** with `static` / `runtime` / `confirmed` evidence tracking,
  traversal in both directions, and JSON round-tripping.
- **Frontend analyzer** — React and Next.js components, user actions, handlers,
  `useState` state, custom hooks, and outbound HTTP calls via `fetch`, `axios`,
  configured clients, and named wrapper functions.
- **Backend analyzer** — NestJS controllers, routes, DTOs, services, constructor
  injection; Express and Fastify routers including inline handlers; Mongoose
  schemas, models, collections, and read/write classification.
- **File-system routing** — Next.js `pages/api/**`, App Router
  `app/**/route.ts`, and Nuxt `server/api/**`, with dynamic segments, catch-alls
  and route groups.
- **Seam matching** between frontend calls and backend routes, with asymmetric
  segment scoring so an interpolated call resolves to a parameterised route.
- **Field-level data lineage** — component state to payload to DTO to
  collection.
- **Feature flows** with transparent risk scoring, every point explained.
- **Impact analysis** — "if I change this, what breaks?", answered by walking
  the graph backwards.
- **Doctor** — broken API calls, dead endpoints, and collections written by more
  than one service.
- **Runtime tracer** (`@flowslens/runtime`) — zero-dependency HTTP middleware,
  Mongoose plugin, and browser tracer that correlates a click with the requests
  it causes.
- **Static + runtime merge** with inclusive and exclusive timings.
- **Generated feature documents** in Markdown.
- **Dashboard** — dependency-free browser UI served by the CLI.
- **CLI** — `scan`, `flows`, `flow`, `impact`, `doctor`, `trace`, `serve`.
- **Structure independence** — files are classified by content rather than by
  folder name; multi-root scanning for frontend and backend in separate
  repositories; `flowlens.config.json` for per-project conventions.
- 176 tests covering unit logic, a tidy example app, a production-shaped
  fixture, eleven project layouts, hostile inputs, the runtime tracer (driven
  through fakes), and the dashboard's HTTP API (driven through the real CLI).

### Fixed during development

Recorded because each one shaped the design, and the reasoning is in
`docs/ARCHITECTURE.md`:

- A URL prefix stripped from frontend calls but not backend routes made 506
  routes and 199 calls match zero times.
- Files classified by path treated any `api/` directory as backend, silently
  discarding every call in frontends that keep their HTTP client there.
- Summing inclusive span durations reported a 204 ms request as 995 ms; timings
  are now exclusive where they are added up.
- Request-wrapper _definitions_ produced phantom endpoints such as
  `GET /:param`, which then appeared as broken calls and could match real
  parameterised routes.
- `shopsettings` was pluralised to `shopsettingses`; Mongoose only appends
  `es` after a double `s`.
- An invalid `--request-fn` regex failed inside every file's error handler and
  reported zero API calls instead of the real reason.
- Chained Mongoose modifiers (`.lean()`, `.sort()`) were counted as separate
  database operations.

[unreleased]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Kishan-Jaiswar/flowlens/releases/tag/v0.1.0
