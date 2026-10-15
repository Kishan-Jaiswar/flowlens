# Graph Report - flowlens  (2026-10-14)

## Corpus Check
- 245 files · ~394,053 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 7, .css 1, .cmd 1)

## Summary
- 3298 nodes · 8925 edges · 126 communities (108 shown, 18 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 515 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a2c25ee3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- packages_core_dist_index
- app.js
- action.ts
- explain.ts
- decisions.ts
- carddata.ts
- portability.test.ts
- cli/src/index.ts
- flow/findings.ts
- ref_node_path
- frontend.ts
- breakage.ts
- core/src/index.ts
- linkdecisions.ts
- renderStacked
- backend.ts
- init.ts
- package.json
- analyzer/unused.ts
- merge.ts
- app.module.ts
- shop.service.ts
- actionsource.ts
- answer
- renderTabs
- analyzeFrontendFile
- dashboard.test.ts
- package-test.mjs
- cli/package.json
- queries.ts
- serve.ts
- SourcePoint
- scopeBadge
- shareddecisions.ts
- condense
- ref_axios
- realworld.test.ts
- commands/diff.ts
- carddata.test.ts
- core/package.json
- runtime/package.json
- escapeHtml
- renderGroup
- renderPageStory
- servermodules.ts
- FlowGraph
- shipments.service.ts
- auditaccuracy.test.ts
- outline.ts
- SourceReader
- mcp.ts
- renderDetails
- where.test.ts
- src/scan.ts
- screens.ts
- CustomerPanel.js
- commands/stack.ts
- callsequence.ts
- navigation.ts
- middleware.ts
- analyzer/stack.ts
- testplan.ts
- apps/api/src/orders/orders.service.ts
- compilerOptions
- Architecture
- @flowslens/cli
- ImportsService
- sidebar.ts
- AdminService
- shareddecisions.test.ts
- config.ts
- @flowslens/runtime
- runtime/src/index.ts
- smoke.mjs
- Changelog
- Flowslens
- queues.ts
- readHttpCall
- gitignore.test.ts
- server.ts
- mongoose.ts
- CustomersController
- customers.tsx
- pages.ts
- @flowslens/core
- NavigationLinks
- nextruntime.test.ts
- relations.ts
- aftermath.ts
- ref_mongoose
- src/http.ts
- lib/models.ts
- browser.ts
- Roadmap
- .sorted
- mongodb.ts
- server.cjs
- instrument.ts
- @flowslens/runtime/browser
- CreateCustomerDto
- Contributing to Flowslens
- Install
- Main exports
- CreateOrderDto
- cli/tsconfig.json
- TraceSink
- runtime/tsconfig.json
- CustomersController
- core/tsconfig.json
- .prettierrc.json
- Security Policy
- Code of Conduct
- List.tsx
- cli/bin/flowlens.mjs
- product.schema.ts
- main.ts
- Commands
- PULL_REQUEST_TEMPLATE.md
- server/models.ts
- CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 88 edges
2. `unwrap()` - 82 edges
3. `condense()` - 75 edges
4. `FlowGraph` - 71 edges
5. `vitest` - 50 edges
6. `SourceReader` - 50 edges
7. `ts-morph` - 41 edges
8. `nearestFunction()` - 39 edges
9. `scan()` - 36 edges
10. `lineOf()` - 35 edges

## Surprising Connections (you probably didn't know these)
- `Supported versions` --references--> `main()`  [INFERRED]
  SECURITY.md → packages/cli/src/index.ts
- `Fixed` --references--> `ownerOf()`  [INFERRED]
  CHANGELOG.md → packages/core/src/analyzer/frontend.ts
- `Added` --references--> `linkDecisions()`  [INFERRED]
  CHANGELOG.md → packages/core/src/flow/linkdecisions.ts
- `Added` --references--> `StepDetail`  [INFERRED]
  CHANGELOG.md → packages/core/src/flow/resolve.ts
- `What is this code for?` --references--> `StepDetail`  [INFERRED]
  README.md → packages/core/src/flow/resolve.ts

## Import Cycles
- None detected.

## Communities (126 total, 18 thin omitted)

### Community 0 - "packages_core_dist_index"
Cohesion: 0.03
Nodes (41): vitest, flows, project, result, save, app, flows, project (+33 more)

### Community 1 - "app.js"
Cohesion: 0.03
Nodes (89): absolutePath(), apiUrl(), applyZoom(), arrow(), bindDocBar(), boxElement(), branchTone(), breakItems() (+81 more)

### Community 2 - "action.ts"
Cohesion: 0.07
Nodes (88): ActionStage, backendSchemaChecks(), baseName(), businessExits(), checkedRows(), classifyExit(), classifyMiddleware(), code() (+80 more)

### Community 3 - "explain.ts"
Cohesion: 0.06
Nodes (75): ActionData, aftermathCautions(), candidateFor(), capitalize(), cell(), CHECK_ROLE, checkRole(), componentName() (+67 more)

### Community 4 - "decisions.ts"
Cohesion: 0.06
Nodes (117): functionAtLine(), functionOf(), returnsOf(), unwrap(), serverMade(), actionDecisions, blobErrorNote(), branchingHelper() (+109 more)

### Community 5 - "carddata.ts"
Cohesion: 0.07
Nodes (65): around(), bindingPath(), binds(), CardCalculation, CardCondition, cardData, CardField, CardSource (+57 more)

### Community 6 - "portability.test.ts"
Cohesion: 0.10
Nodes (4): BIN, EXAMPLES, here, REPO

### Community 7 - "cli/src/index.ts"
Cohesion: 0.08
Nodes (47): FindingsArgs, paint(), RANK, render(), runFindings(), findFlow(), FlowArgs, FlowsArgs (+39 more)

### Community 8 - "flow/findings.ts"
Cohesion: 0.10
Nodes (43): authCallsIn(), BY_ID, checkLoops(), checkMassAssignment(), checkRoutes(), checkSequentialAwaits(), checkTenantFromRequest(), checkTenantScope() (+35 more)

### Community 9 - "ref_node_path"
Cohesion: 0.03
Nodes (38): clock, events, nextSpanId(), recordFlow(), root, packages, root, cli (+30 more)

### Community 10 - "frontend.ts"
Cohesion: 0.07
Nodes (44): ACTION_PROPS, actionLabel(), ActionProps, actionPropsOf(), argumentNames(), callPlacement(), ContextIndex, DeclaredSymbol (+36 more)

### Community 11 - "breakage.ts"
Cohesion: 0.05
Nodes (64): What an edit breaks, analyzeBreakage(), analyzeGroup(), basenameOf(), BreakageInput, BreakageReport, BreakError, callArgs() (+56 more)

### Community 12 - "core/src/index.ts"
Cohesion: 0.05
Nodes (83): BackendIndex, CHAINED_MODIFIERS, DB_EFFECT_LABEL, DB_EFFECT_ORDER, DB_OPERATIONS, DbAccess, DbEffect, IRREGULAR (+75 more)

### Community 13 - "linkdecisions.ts"
Cohesion: 0.18
Nodes (22): countOf(), addressNames(), enter(), escape(), evaluate(), evaluateNode(), fileMentions(), findLine() (+14 more)

### Community 14 - "renderStacked"
Cohesion: 0.23
Nodes (19): bindCopy(), bindFlowJumps(), bindIssueJumps(), bindProjectIssues(), bindStepSelection(), bindTableFolds(), bindTimingJumps(), drawForFlow() (+11 more)

### Community 15 - "backend.ts"
Cohesion: 0.07
Nodes (75): asObjectLiteral(), calleeMember(), calleeReceiver(), callsIn(), decoratorStringArg(), getDecorator(), lineOf(), objectKeys() (+67 more)

### Community 16 - "init.ts"
Cohesion: 0.09
Nodes (47): API_DIRS, buildConfig(), describeIgnore(), Detection, detectSetup(), displayPath(), findHalvesInside(), findSiblingRepositories() (+39 more)

### Community 17 - "package.json"
Cohesion: 0.04
Nodes (47): author, description, devDependencies, eslint, @eslint/js, globals, jsdom, prettier (+39 more)

### Community 18 - "analyzer/unused.ts"
Cohesion: 0.11
Nodes (26): BrokenImport, countWord(), ENTRY_PATTERNS, exportsOf(), filesUnder(), findUnused(), flattenExports(), IMPLICIT_WITH (+18 more)

### Community 19 - "merge.ts"
Cohesion: 0.08
Nodes (34): DetectedRequest, bestRouteMatch(), DYNAMIC_MARKER, HTTP_METHODS, HttpMethod, matchScore(), normalizeSegment(), PARAM (+26 more)

### Community 20 - "app.module.ts"
Cohesion: 0.09
Nodes (8): CustomersService, Order, OrderDocument, OrderSchema, OrdersController, OrdersService, ProductsController, ProductsService

### Community 21 - "shop.service.ts"
Cohesion: 0.12
Nodes (8): ShopController, ShopService, ShopSettings, ShopSettingsDocument, ShopSettingsSchema, StockMap, StockMapDocument, StockMapSchema

### Community 22 - "actionsource.ts"
Cohesion: 0.07
Nodes (51): branchRows(), collectFrontSchemas(), confirmTexts(), contextRows(), decodeEntities(), derivedStates(), describeView(), eventOn() (+43 more)

### Community 23 - "answer"
Cohesion: 0.16
Nodes (29): answer(), cardBlock(), cardDecisionsHtml(), cardDocsHtml(), cardEndpoints(), cardImpactHtml(), cardPathHtml(), cardPerfHtml() (+21 more)

### Community 24 - "renderTabs"
Cohesion: 0.14
Nodes (35): decisionsKey(), decisionsUrl(), findLink(), findNavEntry(), getJson(), isPageEntry(), linkFlowId(), load() (+27 more)

### Community 25 - "analyzeFrontendFile"
Cohesion: 0.14
Nodes (23): calleeName(), aftermathMeta(), analyzeComponentBody(), analyzeFrontendFile(), callbackOf(), componentEventMeta(), componentProps(), containsJsx() (+15 more)

### Community 26 - "dashboard.test.ts"
Cohesion: 0.07
Nodes (22): apiResponse(), entryActions(), findEntry(), flows, graph, here, loadDashboard(), openChart() (+14 more)

### Community 27 - "package-test.mjs"
Cohesion: 0.09
Nodes (27): argv, child, CLI_BIN, CLI_DIST, fail(), needsBuild(), newestSourceTime(), npm() (+19 more)

### Community 28 - "cli/package.json"
Cohesion: 0.06
Nodes (30): author, bin, flowlens, bugs, email, url, dependencies, @flowslens/core (+22 more)

### Community 29 - "queries.ts"
Cohesion: 0.11
Nodes (32): callerOf(), callerParams(), componentOf(), handlersFromExpression(), locateCalls(), locateChild(), locateEntry(), nearestComponent() (+24 more)

### Community 30 - "serve.ts"
Cohesion: 0.07
Nodes (40): ChangedFile, changedFiles(), ChangedFilesResult, git(), statusOf(), unquote(), withCommittedText(), filesSince() (+32 more)

### Community 31 - "SourcePoint"
Cohesion: 0.08
Nodes (28): Functionish, CallContext, Confirmation, Ctx, DbOp, DocRow, FrontFn, GuardExit (+20 more)

### Community 32 - "scopeBadge"
Cohesion: 0.20
Nodes (12): cardChecks(), cardDecisionTree(), formatMs(), impactBadge(), measuredElsewhereHtml(), renderScopeImpact(), scopeActionIds(), scopeBadge() (+4 more)

### Community 33 - "shareddecisions.ts"
Cohesion: 0.18
Nodes (22): DecisionNode, DecisionSide, markUncaught(), SharedUse, collectRequests(), Scope, endsAll(), expandedDecisions() (+14 more)

### Community 34 - "condense"
Cohesion: 0.17
Nodes (23): bodyArgument(), branchCalls(), classifyReaction(), ClientFacts, configQueryKeys(), declaredResponseType(), headerLines(), pathParams() (+15 more)

### Community 37 - "commands/diff.ts"
Cohesion: 0.09
Nodes (15): DiffArgs, escapeCell(), fail(), findingsOf(), git(), Level, levelOf(), renderDiff() (+7 more)

### Community 38 - "carddata.test.ts"
Cohesion: 0.08
Nodes (10): app, card(), flows, { graph }, read(), reader, clinic, app (+2 more)

### Community 39 - "core/package.json"
Cohesion: 0.07
Nodes (27): author, bugs, email, url, dependencies, ts-morph, description, engines (+19 more)

### Community 40 - "runtime/package.json"
Cohesion: 0.07
Nodes (27): author, bugs, email, url, description, engines, node, exports (+19 more)

### Community 41 - "escapeHtml"
Cohesion: 0.11
Nodes (50): atLine(), beforeYouChangeHtml(), broadHtml(), brokenInAppHtml(), brokenLineHtml(), codeLine(), codeList(), curlFor() (+42 more)

### Community 42 - "renderGroup"
Cohesion: 0.12
Nodes (19): cardContents(), cardRow(), clearFilter(), drawFlowList(), filteredFlows(), groupIsOpen(), groupTotal(), linkItem() (+11 more)

### Community 43 - "renderPageStory"
Cohesion: 0.09
Nodes (32): actionIssuesHtml(), actionKind(), actionName(), actionPlace(), actionStory(), cardOf(), countLinks(), dataName() (+24 more)

### Community 44 - "servermodules.ts"
Cohesion: 0.18
Nodes (17): Classification, classifyFile(), CLIENT_MODULES, containsJsx(), FileSide, importSpecifiers(), isFileSystemRoute(), isFrontendCandidate() (+9 more)

### Community 45 - "FlowGraph"
Cohesion: 0.07
Nodes (49): addMountActions(), analyzeFrontend(), linkEffectRefetches(), linkPopupFeatures(), linkPropBindings(), linkShowingClicks(), linkStateReads(), linkStateRefetches() (+41 more)

### Community 46 - "shipments.service.ts"
Cohesion: 0.11
Nodes (5): Shipment, ShipmentDocument, ShipmentSchema, ShipmentsController, ShipmentsService

### Community 47 - "auditaccuracy.test.ts"
Cohesion: 0.10
Nodes (11): flows, project, scanned, submit, doc(), flowNamed(), flows, { graph } (+3 more)

### Community 48 - "outline.ts"
Cohesion: 0.15
Nodes (28): arrayItems(), attribute(), bindMap(), childHeading(), componentFunction(), drawnWhen(), Env, functionOf() (+20 more)

### Community 49 - "SourceReader"
Cohesion: 0.14
Nodes (11): ExplainActionOptions, SourceReader, CardDataOptions, ActionDecisionsOptions, Ctx, FindingsOptions, LinkDecisionsOptions, AppNavigationOptions (+3 more)

### Community 50 - "mcp.ts"
Cohesion: 0.17
Nodes (10): McpArgs, Request, runMcp(), SUPPORTED, Tool, ToolError, grid(), renderUnused() (+2 more)

### Community 51 - "renderDetails"
Cohesion: 0.27
Nodes (12): effectOf(), eventVerb(), renderActionHeader(), renderCollectionSummary(), renderColumns(), renderDetails(), renderGraph(), renderNode() (+4 more)

### Community 52 - "where.test.ts"
Cohesion: 0.16
Nodes (9): COMMANDS_WITH_ARGUMENT, COMMANDS_WITH_LOCATION, looksLikePath(), SOURCE_EXTENSIONS, SplitOptions, splitPositionals, exampleScan(), graph() (+1 more)

### Community 53 - "src/scan.ts"
Cohesion: 0.06
Nodes (54): Changed, Changed, 1. Endpoint constants (`analyzer/constants.ts`), DEFAULT_BACKEND_CONFIG, collectConstants(), ConstantTable, emptyConstantTable(), stringConstantsIn() (+46 more)

### Community 54 - "screens.ts"
Cohesion: 0.14
Nodes (25): componentPhrase(), rename(), ACRONYM_VALUES, ACRONYMS, basenameOf(), composeTitle(), featureFolderOf(), FRAMEWORK_FILES (+17 more)

### Community 55 - "CustomerPanel.js"
Cohesion: 0.22
Nodes (17): 2. Wrapper functions (`readWrapperCall`), Working with a real codebase, CustomerPanel(), createShipment, duplicated, getCustomerById, getCustomersList, getShopSettings (+9 more)

### Community 56 - "commands/stack.ts"
Cohesion: 0.15
Nodes (6): describeShape(), note(), runStack(), StackArgs, project, report

### Community 57 - "callsequence.ts"
Cohesion: 0.19
Nodes (19): addSetter(), argumentIdentifiers(), branchFacts(), calleeName(), callSequenceFacts, CONCURRENT, condense(), continuationDepth() (+11 more)

### Community 58 - "navigation.ts"
Cohesion: 0.16
Nodes (21): AUTH_PAGES, authRank(), componentFile(), CONTENT_KEYS, firstComponent(), flatten(), isRoutish(), LABEL_KEYS (+13 more)

### Community 59 - "middleware.ts"
Cohesion: 0.24
Nodes (13): addMiddleware(), DECORATOR_ROLES, linkExpressMiddleware(), linkNestConsumerMiddleware(), linkNestMiddleware(), MIDDLEWARE_LABEL, MiddlewareInput, middlewareNames() (+5 more)

### Community 60 - "analyzer/stack.ts"
Cohesion: 0.13
Nodes (18): detectStack(), findManifests(), LOCKFILES, MARKER_FILES, record(), rel(), Rule, ruleFor() (+10 more)

### Community 61 - "testplan.ts"
Cohesion: 0.17
Nodes (16): DocGroup, DocLine, StageKey, clip(), groupsOf(), ORDER, plain(), planTests() (+8 more)

### Community 62 - "apps/api/src/orders/orders.service.ts"
Cohesion: 0.14
Nodes (5): Order, OrderDocument, OrderSchema, OrdersController, OrdersService

### Community 63 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, composite, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+10 more)

### Community 64 - "Architecture"
Cohesion: 0.11
Nodes (19): 3. Interpolated base URLs, Architecture, Evidence, not diagrams, Failing fast on configuration, Known limits, Matching the seam, Multi-root scanning, Phantom endpoints (+11 more)

### Community 65 - "@flowslens/cli"
Cohesion: 0.11
Nodes (17): 1. Scan, 2. Pick a feature and follow it, 3. Or click around instead, Commands, Documentation, First: will this work on my project?, @flowslens/cli, Install (+9 more)

### Community 66 - "ImportsService"
Cohesion: 0.14
Nodes (6): ImportsController, ImportsService, Deliberate findings, Example: shop CRUD app, Layout, Try it

### Community 67 - "sidebar.ts"
Cohesion: 0.20
Nodes (21): pageRouteOf(), appNavigation, authPages(), normalizeRoute(), routeKey(), buildPageIndex(), flowPages(), pagesOfFile() (+13 more)

### Community 69 - "shareddecisions.test.ts"
Cohesion: 0.18
Nodes (11): Added, Changed, Fixed, [Unreleased], DecisionGroup, DecisionStep, sharedPartTree(), at() (+3 more)

### Community 70 - "config.ts"
Cohesion: 0.29
Nodes (10): CONFIG_FILENAMES, contains(), farRoots(), loadConfig(), loaded(), LoadedConfig, mergeConfig(), message() (+2 more)

### Community 71 - "@flowslens/runtime"
Cohesion: 0.11
Nodes (17): bootstrap(), Copy the block for your stack, Do you need this?, Documentation, Express (CommonJS — the `require()` style), Express (ESM), @flowslens/runtime, Install (+9 more)

### Community 72 - "runtime/src/index.ts"
Cohesion: 0.19
Nodes (12): globalRef, SPAN_HEADER, STORAGE_KEY, TRACE_HEADER, TraceContext, HttpTracerOptions, TracedRequest, ServerTracingOptions (+4 more)

### Community 73 - "smoke.mjs"
Cohesion: 0.22
Nodes (16): assertNoArtifactsIn(), BIN, check(), dashboard(), expectFailure(), fail(), flowlens(), indent() (+8 more)

### Community 74 - "Changelog"
Cohesion: 0.07
Nodes (28): [0.1.0] - 2026-08-24, [1.0.0] - 2026-08-31, [1.1.0] - 2026-09-15, [1.1.1] - 2026-09-15, [1.1.2] - 2026-09-15, [1.2.0] - 2026-09-30, [1.3.0] - 2026-10-05, [1.3.1] - 2026-10-05 (+20 more)

### Community 75 - "Flowslens"
Cohesion: 0.12
Nodes (14): Any project structure, Development, flowlens.config.json, Flowslens, License, Packages, Project status, Repository layout (+6 more)

### Community 76 - "queues.ts"
Cohesion: 0.29
Nodes (12): enclosingFunction(), functionName(), ownerComponentName(), ownerOf(), providedMembers(), providedObject(), add(), exportedStrings() (+4 more)

### Community 77 - "readHttpCall"
Cohesion: 0.29
Nodes (13): propertyValue(), readInterpolation(), readPathLike(), bodyObject(), bodyObjectFrom(), buildRequest(), isHttpMethod(), queryKeysOf() (+5 more)

### Community 78 - "gitignore.test.ts"
Cohesion: 0.12
Nodes (7): Changed, BIN, git(), here, REPO, repository(), temp

### Community 79 - "server.ts"
Cohesion: 0.24
Nodes (7): Done — v1.2 (published), Next.js App Router — let the CLI write it, register(), EmitArgs, globalRef, installServerTracing(), PATCHED

### Community 80 - "mongoose.ts"
Cohesion: 0.21
Nodes (9): Not done, and it matters, collectionOf(), DOCUMENT_HOOKS, flowlensMongoose(), MongooseHookTarget, MongooseLikeSchema, MongoosePluginOptions, QUERY_HOOKS (+1 more)

### Community 82 - "customers.tsx"
Cohesion: 0.23
Nodes (9): api, CustomerForm(), OrderForm(), Product, CreateCustomerInput, useCreateCustomer(), Customer, CustomersPage() (+1 more)

### Community 83 - "pages.ts"
Cohesion: 0.22
Nodes (13): add(), defaultImports(), FileIndex, FlowPage, FlowPagesOptions, namedImports(), NeedsProps, pageOf() (+5 more)

### Community 84 - "@flowslens/core"
Cohesion: 0.11
Nodes (19): 1. List every feature that reaches the backend, 2. Ask what a line of code is for, 3. Ask what breaks if you change something, A complete first script, Do you want this package?, Documentation, Every way an action can go, Failing a CI job on findings (+11 more)

### Community 86 - "nextruntime.test.ts"
Cohesion: 0.05
Nodes (18): Adapters, not special cases, Which collections, and what happened to them, middleware, OrdersService, project, server, service, sink (+10 more)

### Community 87 - "relations.ts"
Cohesion: 0.24
Nodes (17): CollectionRelation, collectionRelations(), declaredRefs(), fieldNodeFor(), followedPathsIn(), inferredFromNames(), isSourceRef(), linkCollectionRelations() (+9 more)

### Community 88 - "aftermath.ts"
Cohesion: 0.21
Nodes (17): Aftermath, aftermathOf(), EMPTY, firstStringLike(), invalidatedKeys(), invalidatedPrefixes(), INVALIDATORS, isOnErrorCallback() (+9 more)

### Community 89 - "ref_mongoose"
Cohesion: 0.09
Nodes (10): AuditLog, AuditLogDocument, AuditLogSchema, AuditService, Customer, CustomerDocument, CustomerSchema, Customer (+2 more)

### Community 90 - "src/http.ts"
Cohesion: 0.24
Nodes (14): All exports, currentContext(), newId(), withContext(), DEFAULT_IGNORE, flowlensHttp(), headerValue(), requestPath() (+6 more)

### Community 91 - "lib/models.ts"
Cohesion: 0.20
Nodes (6): Every action, including the ones that are not clicks, Stacks where the chain hides in the middle, What one action shows you, DELETE(), CustomerModel, OrderModel

### Community 92 - "browser.ts"
Cohesion: 0.31
Nodes (9): activeAction(), BrowserSpan, BrowserTracerOptions, clientSpan(), defaultEndpoint(), installBrowserTracer(), labelOf(), pathOf() (+1 more)

### Community 93 - "Roadmap"
Cohesion: 0.18
Nodes (10): Done since v1.0, Done — unreleased, Done — v1.0 (published), Explicit non-goals, Later — AI, More of the stack, Next, Roadmap (+2 more)

### Community 94 - ".sorted"
Cohesion: 0.39
Nodes (5): baseName(), compareKeys(), fileOf(), SequenceOrder, sidebarEntries()

### Community 95 - "mongodb.ts"
Cohesion: 0.24
Nodes (9): AnyFunction, AWAITED, CURSORS, isPromise(), TERMINALS, timed(), traceCollection(), traceDb() (+1 more)

### Community 96 - "server.cjs"
Cohesion: 0.18
Nodes (8): express, Item, mongoose, router, app, express, mongoose, Note

### Community 97 - "instrument.ts"
Cohesion: 0.39
Nodes (7): installCommand(), InstrumentArgs, mentions(), readManifest(), rel(), runInstrument(), SKIP

### Community 100 - "Contributing to Flowslens"
Cohesion: 0.20
Nodes (9): Adding support for a framework or database, Before you open a PR, Commit messages, Contributing to Flowslens, Getting set up, How the code is laid out, Reporting a bug, Tests (+1 more)

### Community 102 - "Install"
Cohesion: 0.22
Nodes (9): From source, If your terminal cannot draw boxes, Install, Naming a project, On your PATH, from a clone, Or install it once, Start on a project you have never scanned, The short way — no install at all (+1 more)

### Community 103 - "Main exports"
Cohesion: 0.05
Nodes (63): [1.0.1] - 2026-09-09, Added, Documentation, Fixed, Main exports, EMPTY, findTestFiles(), FlowTests (+55 more)

### Community 106 - "cli/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, outDir, rootDir, extends, include, ../../tsconfig.base.json, references

### Community 107 - "TraceSink"
Cohesion: 0.39
Nodes (3): MongoTracingOptions, defaultTraceFile(), TraceSink

### Community 108 - "runtime/tsconfig.json"
Cohesion: 0.25
Nodes (7): compilerOptions, lib, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 110 - "core/tsconfig.json"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, extends, include, ../../tsconfig.base.json

### Community 111 - ".prettierrc.json"
Cohesion: 0.29
Nodes (6): arrowParens, overrides, printWidth, semi, singleQuote, trailingComma

### Community 113 - "Security Policy"
Cohesion: 0.33
Nodes (5): Reporting a vulnerability, Security Policy, Supported versions, Things to know, What Flowslens does with your code

### Community 114 - "Code of Conduct"
Cohesion: 0.33
Nodes (5): Code of Conduct, Enforcement, Expected behaviour, The short version, Unacceptable behaviour

### Community 115 - "List.tsx"
Cohesion: 0.60
Nodes (4): Following a call into the service layer, archiveCustomer(), fetchCustomers(), List()

### Community 116 - "cli/bin/flowlens.mjs"
Cohesion: 0.33
Nodes (3): code, current, MINIMUM_NODE

### Community 118 - "product.schema.ts"
Cohesion: 0.25
Nodes (3): Product, ProductDocument, ProductSchema

### Community 120 - "Commands"
Cohesion: 0.29
Nodes (7): Ask your AI assistant, answered from the graph, Commands, What a feature is called, What a pull request does to the app, What is already wrong here, What is this code for?, What nothing uses

### Community 122 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.50
Nodes (3): Checklist, What this changes, Why

## Knowledge Gaps
- **9 isolated node(s):** `@types/node`, `eslint`, `jsdom`, `prettier`, `typescript` (+4 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 984 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ts-morph` connect `condense` to `packages_core_dist_index`, `action.ts`, `decisions.ts`, `carddata.ts`, `flow/findings.ts`, `frontend.ts`, `breakage.ts`, `linkdecisions.ts`, `backend.ts`, `analyzer/unused.ts`, `actionsource.ts`, `queries.ts`, `core/package.json`, `servermodules.ts`, `outline.ts`, `src/scan.ts`, `callsequence.ts`, `navigation.ts`, `middleware.ts`, `queues.ts`, `relations.ts`, `aftermath.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `FlowGraph` (e.g. with `Main exports` and `What the graph contains`) actually correct?**
  _`FlowGraph` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@types/node`, `eslint`, `jsdom` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `packages_core_dist_index` be split into smaller, more focused modules?**
  _Cohesion score 0.031960049937578026 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `packages_core_dist_index` to `realworld.test.ts`, `commands/diff.ts`, `carddata.test.ts`, `cli/src/index.ts`, `carddata.ts`, `ref_node_path`, `portability.test.ts`, `shareddecisions.test.ts`, `gitignore.test.ts`, `auditaccuracy.test.ts`, `package.json`, `where.test.ts`, `nextruntime.test.ts`, `commands/stack.ts`, `dashboard.test.ts`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.03495630461922597 - nodes in this community are weakly interconnected._
- **Why does `Fixed` connect `shareddecisions.test.ts` to `CustomersController`, `CustomerPanel.js`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._