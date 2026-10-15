# Graph Report - flowlens  (2026-10-09)

## Corpus Check
- 241 files · ~316,233 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 7, .css 1, .cmd 1)

## Summary
- 3162 nodes · 8411 edges · 133 communities (115 shown, 18 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 451 edges (avg confidence: 0.88)
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
- dashboard.test.ts
- cli/src/index.ts
- flow/findings.ts
- ref_node_path
- frontend.ts
- breakage.ts
- core/src/index.ts
- linkdecisions.ts
- escapeHtml
- backend.ts
- init.ts
- package.json
- serve.ts
- src/scan.ts
- app.module.ts
- ref_mongoose
- actionsource.ts
- FeatureFlow
- renderTabs
- graph.ts
- tracer.test.ts
- package-test.mjs
- cli/package.json
- SourceReader
- Main exports
- nearestFunction
- answer
- analyzer/unused.ts
- unwrap
- ref_axios
- relations.test.ts
- commands/diff.ts
- carddata.test.ts
- core/package.json
- runtime/package.json
- cardDocsHtml
- FlowGraph
- renderPageStory
- shop.service.ts
- api.ts
- shipments.service.ts
- ast.ts
- fileroutes.ts
- resolve.ts
- merge.ts
- renderDocs
- portability.test.ts
- SourcePoint
- screens.ts
- CustomerPanel.js
- realworld.test.ts
- callsequence.ts
- navigation.ts
- renderGroup
- analyzer/stack.ts
- testplan.ts
- apps/api/src/orders/orders.service.ts
- compilerOptions
- Architecture
- @flowslens/cli
- relations.ts
- sidebar.ts
- AdminService
- document.ts
- servermodules.ts
- @flowslens/runtime
- runtime/src/index.ts
- smoke.mjs
- Changelog
- Flowslens
- ImportsService
- instrument.ts
- gitignore.test.ts
- commands/stack.ts
- mongoose.ts
- CustomersController
- customers.tsx
- pages.ts
- @flowslens/core
- PageIndex
- nextruntime.test.ts
- .collection
- aftermath.ts
- CreateCustomerDto
- src/http.ts
- lib/models.ts
- browser.ts
- Roadmap
- config.ts
- mongodb.ts
- server.cjs
- CreateOrderDto
- middleware.ts
- .sorted
- Contributing to Flowslens
- analyzer/http.ts
- Install
- FlowslensConfig
- server.ts
- product.schema.ts
- cli/tsconfig.json
- TraceSink
- runtime/tsconfig.json
- CustomersController
- core/tsconfig.json
- .prettierrc.json
- Commands
- [1.0.0] - 2026-08-31
- Code of Conduct
- List.tsx
- cli/bin/flowlens.mjs
- The three things you will actually do
- Security Policy
- main.ts
- @flowslens/runtime/browser
- [Unreleased]
- PULL_REQUEST_TEMPLATE.md
- server/models.ts
- [1.1.2] - 2026-09-15
- packages_runtime_dist_index
- CLAUDE.md

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 88 edges
2. `unwrap()` - 77 edges
3. `FlowGraph` - 70 edges
4. `condense()` - 68 edges
5. `SourceReader` - 50 edges
6. `vitest` - 48 edges
7. `ts-morph` - 38 edges
8. `SourcePoint` - 34 edges
9. `Main exports` - 34 edges
10. `nearestFunction()` - 33 edges

## Surprising Connections (you probably didn't know these)
- `Supported versions` --references--> `main()`  [INFERRED]
  SECURITY.md → packages/cli/src/index.ts
- `Known limits` --references--> `isConcreteEndpoint()`  [INFERRED]
  docs/ARCHITECTURE.md → packages/core/src/analyzer/frontend.ts
- `Phantom endpoints` --references--> `isConcreteEndpoint()`  [INFERRED]
  docs/ARCHITECTURE.md → packages/core/src/analyzer/frontend.ts
- `Fixed` --references--> `ownerOf()`  [INFERRED]
  CHANGELOG.md → packages/core/src/analyzer/frontend.ts
- `Added` --references--> `linkDecisions()`  [INFERRED]
  CHANGELOG.md → packages/core/src/flow/linkdecisions.ts

## Import Cycles
- None detected.

## Communities (133 total, 18 thin omitted)

### Community 0 - "packages_core_dist_index"
Cohesion: 0.03
Nodes (44): vitest, roots, flows, project, result, save, app, flows (+36 more)

### Community 1 - "app.js"
Cohesion: 0.04
Nodes (87): apiUrl(), applyZoom(), arrow(), bindDocBar(), boxElement(), branchTone(), buildBlock(), buildSeq() (+79 more)

### Community 2 - "action.ts"
Cohesion: 0.07
Nodes (86): baseName(), bodyArgument(), businessExits(), checkedRows(), classifyExit(), classifyMiddleware(), classifyReaction(), code() (+78 more)

### Community 3 - "explain.ts"
Cohesion: 0.06
Nodes (78): RelationVia, FlowAftermath, ActionData, aftermathCautions(), candidateFor(), capitalize(), cell(), CHECK_ROLE (+70 more)

### Community 4 - "decisions.ts"
Cohesion: 0.08
Nodes (75): functionAtLine(), functionOf(), actionDecisions, cacheKeyWords(), callbackIn(), calledName(), calleeText(), CallKind (+67 more)

### Community 5 - "carddata.ts"
Cohesion: 0.07
Nodes (65): around(), bindingPath(), binds(), CardCalculation, CardCondition, cardData, CardField, CardSource (+57 more)

### Community 6 - "dashboard.test.ts"
Cohesion: 0.04
Nodes (36): McpArgs, Request, runMcp(), SUPPORTED, Tool, ToolError, grid(), renderUnused() (+28 more)

### Community 7 - "cli/src/index.ts"
Cohesion: 0.08
Nodes (49): FindingsArgs, paint(), RANK, render(), runFindings(), findFlow(), FlowArgs, FlowsArgs (+41 more)

### Community 8 - "flow/findings.ts"
Cohesion: 0.07
Nodes (66): authCallsIn(), BY_ID, checkLoops(), checkMassAssignment(), checkRoutes(), checkSequentialAwaits(), checkTenantFromRequest(), checkTenantScope() (+58 more)

### Community 9 - "ref_node_path"
Cohesion: 0.04
Nodes (29): clock, events, nextSpanId(), recordFlow(), root, packages, root, cli (+21 more)

### Community 10 - "frontend.ts"
Cohesion: 0.07
Nodes (63): calleeName(), enclosingFunction(), functionName(), propertyValue(), readPathLike(), isFrontendCandidate(), ACTION_PROPS, actionLabel() (+55 more)

### Community 11 - "breakage.ts"
Cohesion: 0.06
Nodes (58): analyzeGroup(), basenameOf(), BreakageReport, BreakError, callArgs(), ChangedSymbol, changeWeight(), checkedSignature() (+50 more)

### Community 12 - "core/src/index.ts"
Cohesion: 0.06
Nodes (53): FileSide, emptyConstantTable(), EFFECT_LABEL, EffectKind, DEFAULT_ACTION_PROPS, DEFAULT_INPUT_ACTION_PROPS, bestRouteMatch(), matchScore() (+45 more)

### Community 13 - "linkdecisions.ts"
Cohesion: 0.08
Nodes (51): countOf(), DecisionGroup, DecisionNode, DecisionSide, DecisionStep, markUncaught(), SharedUse, addressNames() (+43 more)

### Community 14 - "escapeHtml"
Cohesion: 0.08
Nodes (53): absolutePath(), atLine(), beforeYouChangeHtml(), bindStepSelection(), broadHtml(), brokenInAppHtml(), brokenLineHtml(), codeLine() (+45 more)

### Community 15 - "backend.ts"
Cohesion: 0.12
Nodes (48): asObjectLiteral(), calleeMember(), calleeReceiver(), callsIn(), decoratorStringArg(), getDecorator(), lineOf(), analyzeBackend() (+40 more)

### Community 16 - "init.ts"
Cohesion: 0.09
Nodes (47): API_DIRS, buildConfig(), describeIgnore(), Detection, detectSetup(), displayPath(), findHalvesInside(), findSiblingRepositories() (+39 more)

### Community 17 - "package.json"
Cohesion: 0.04
Nodes (47): author, description, devDependencies, eslint, @eslint/js, globals, jsdom, prettier (+39 more)

### Community 18 - "serve.ts"
Cohesion: 0.08
Nodes (30): answerLater(), browserCommand(), collectSpans(), deny(), displayHost(), entryActions(), fileSize(), findEntry() (+22 more)

### Community 19 - "src/scan.ts"
Cohesion: 0.11
Nodes (32): 1. Endpoint constants (`analyzer/constants.ts`), collectConstants(), ConstantTable, stringConstantsIn(), collectionAliasesOf(), collectImports(), collectImportUses(), EXTENSIONS (+24 more)

### Community 20 - "app.module.ts"
Cohesion: 0.09
Nodes (8): CustomersService, Order, OrderDocument, OrderSchema, OrdersController, OrdersService, ProductsController, ProductsService

### Community 21 - "ref_mongoose"
Cohesion: 0.09
Nodes (10): AuditLog, AuditLogDocument, AuditLogSchema, AuditService, Customer, CustomerDocument, CustomerSchema, Customer (+2 more)

### Community 22 - "actionsource.ts"
Cohesion: 0.10
Nodes (34): confirmTexts(), eventOn(), fieldLabels(), handlersFromExpression(), isFormTrigger(), isPageLoad(), labelText(), locateChild() (+26 more)

### Community 23 - "FeatureFlow"
Cohesion: 0.10
Nodes (32): Done since v1.0, EMPTY, findTestFiles(), FlowTests, indexTests(), isFile(), readCases(), readCoveredFiles() (+24 more)

### Community 24 - "renderTabs"
Cohesion: 0.17
Nodes (33): bindIssueJumps(), bindProjectIssues(), countLinks(), findLink(), findNavEntry(), getJson(), isPageEntry(), linkFlowId() (+25 more)

### Community 25 - "graph.ts"
Cohesion: 0.11
Nodes (28): ActionDoc, ScreenIndexEntry, analyzeFlowImpact(), classifyShared(), contestedWrites(), disambiguate(), FlowImpact, SharedBy (+20 more)

### Community 26 - "tracer.test.ts"
Cohesion: 0.08
Nodes (9): middleware, OrdersService, project, server, service, sink, traceFile, spans() (+1 more)

### Community 27 - "package-test.mjs"
Cohesion: 0.09
Nodes (27): argv, child, CLI_BIN, CLI_DIST, fail(), needsBuild(), newestSourceTime(), npm() (+19 more)

### Community 28 - "cli/package.json"
Cohesion: 0.06
Nodes (30): author, bin, flowlens, bugs, email, url, dependencies, @flowslens/core (+22 more)

### Community 29 - "SourceReader"
Cohesion: 0.09
Nodes (25): Ctx, ExplainActionOptions, SchemaFacts, SourceReader, ActionDecisionsOptions, Ctx, FindingsOptions, AppNavigationOptions (+17 more)

### Community 30 - "Main exports"
Cohesion: 0.13
Nodes (26): [1.3.0] - 2026-10-05, Added, Changed, Fixed, Main exports, lineageTargets(), linkDataLineage(), renderDecisionTree() (+18 more)

### Community 31 - "nearestFunction"
Cohesion: 0.13
Nodes (29): backendSchemaChecks(), callerOf(), collectFrontSchemas(), componentOf(), locateCalls(), nearestComponent(), ownCalls(), ownCallsOf() (+21 more)

### Community 32 - "answer"
Cohesion: 0.13
Nodes (29): actionIssuesHtml(), answer(), breakItems(), cardChecks(), cardDecisionsHtml(), cardDecisionTree(), cardOf(), changesVerdict() (+21 more)

### Community 33 - "analyzer/unused.ts"
Cohesion: 0.11
Nodes (27): ImportUse, BrokenImport, countWord(), ENTRY_PATTERNS, exportsOf(), filesUnder(), findUnused(), flattenExports() (+19 more)

### Community 34 - "unwrap"
Cohesion: 0.17
Nodes (28): branchCalls(), ClientFacts, headerLines(), objectFrom(), numbersIn(), returnsOf(), statusFromInit(), statusOf() (+20 more)

### Community 36 - "relations.test.ts"
Cohesion: 0.09
Nodes (14): COMMANDS_WITH_ARGUMENT, COMMANDS_WITH_LOCATION, looksLikePath(), SOURCE_EXTENSIONS, SplitOptions, splitPositionals, scanned, exampleScan() (+6 more)

### Community 37 - "commands/diff.ts"
Cohesion: 0.11
Nodes (18): ChangedFile, changedFiles(), ChangedFilesResult, git(), statusOf(), unquote(), withCommittedText(), DiffArgs (+10 more)

### Community 38 - "carddata.test.ts"
Cohesion: 0.08
Nodes (10): app, card(), flows, { graph }, read(), reader, clinic, app (+2 more)

### Community 39 - "core/package.json"
Cohesion: 0.07
Nodes (27): author, bugs, email, url, dependencies, ts-morph, description, engines (+19 more)

### Community 40 - "runtime/package.json"
Cohesion: 0.07
Nodes (27): author, bugs, email, url, description, engines, node, exports (+19 more)

### Community 41 - "cardDocsHtml"
Cohesion: 0.15
Nodes (27): cardBlock(), cardDocsHtml(), cardEndpoints(), cardImpactHtml(), cardPathHtml(), cardPerfHtml(), cardTestsHtml(), fieldList() (+19 more)

### Community 42 - "FlowGraph"
Cohesion: 0.16
Nodes (9): LocatedAction, ApiCallDetail, Walk, FlowGraph, EdgeKind, FlowEdge, FlowNode, GraphMeta (+1 more)

### Community 43 - "renderPageStory"
Cohesion: 0.15
Nodes (25): actionKind(), actionName(), actionPlace(), actionStory(), dataName(), dataSentence(), flowItem(), flowTitle() (+17 more)

### Community 44 - "shop.service.ts"
Cohesion: 0.12
Nodes (8): ShopController, ShopService, ShopSettings, ShopSettingsDocument, ShopSettingsSchema, StockMap, StockMapDocument, StockMapSchema

### Community 45 - "api.ts"
Cohesion: 0.15
Nodes (20): aftermathFor(), ApiDataAccess, ApiField, ApiRoute, asStrings(), describeWhen(), disambiguate(), flowApis (+12 more)

### Community 46 - "shipments.service.ts"
Cohesion: 0.11
Nodes (5): Shipment, ShipmentDocument, ShipmentSchema, ShipmentsController, ShipmentsService

### Community 47 - "ast.ts"
Cohesion: 0.13
Nodes (17): objectKeys(), readInterpolation(), readString(), stripQuotes(), injectedModelName(), EffectMatch, EffectRule, hostOf() (+9 more)

### Community 48 - "fileroutes.ts"
Cohesion: 0.16
Nodes (20): BackendConfig, CollectionAliases, analyzeFileRoutes(), declareHandler(), declareVerbHandler(), FileRouteConfig, isHttpMethod(), methodsOf() (+12 more)

### Community 49 - "resolve.ts"
Cohesion: 0.14
Nodes (19): isGenericComponentName(), schemaOf(), attributeCallSites(), collectionAccesses(), distinctTitles(), EXECUTION_EDGES, LAYER_ORDER, resolveFlow() (+11 more)

### Community 50 - "merge.ts"
Cohesion: 0.14
Nodes (19): edgeKindFor(), isWriteOperation(), MergeOptions, MergeResult, mergeRuntimeTrace(), nearestResolvedAncestor(), observeNode(), runtimeEdgeKind() (+11 more)

### Community 51 - "renderDocs"
Cohesion: 0.18
Nodes (21): bindCopy(), bindFlowJumps(), bindTableFolds(), bindTimingJumps(), decisionsKey(), decisionsUrl(), drawForFlow(), loadDecisions() (+13 more)

### Community 52 - "portability.test.ts"
Cohesion: 0.10
Nodes (4): BIN, EXAMPLES, here, REPO

### Community 53 - "SourcePoint"
Cohesion: 0.10
Nodes (21): Functionish, CallContext, Confirmation, DbOp, FrontFn, GuardExit, GuardFacts, HeaderRow (+13 more)

### Community 54 - "screens.ts"
Cohesion: 0.17
Nodes (20): ACRONYM_VALUES, ACRONYMS, basenameOf(), composeTitle(), featureFolderOf(), FRAMEWORK_FILES, GENERIC_DIRS, isMeaningfulSegment() (+12 more)

### Community 55 - "CustomerPanel.js"
Cohesion: 0.22
Nodes (17): 2. Wrapper functions (`readWrapperCall`), Working with a real codebase, CustomerPanel(), createShipment, duplicated, getCustomerById, getCustomersList, getShopSettings (+9 more)

### Community 57 - "callsequence.ts"
Cohesion: 0.19
Nodes (19): addSetter(), argumentIdentifiers(), branchFacts(), calleeName(), callSequenceFacts, CONCURRENT, condense(), continuationDepth() (+11 more)

### Community 58 - "navigation.ts"
Cohesion: 0.19
Nodes (19): AUTH_PAGES, componentFile(), CONTENT_KEYS, firstComponent(), flatten(), isRoutish(), LABEL_KEYS, LINK_KEYS (+11 more)

### Community 59 - "renderGroup"
Cohesion: 0.12
Nodes (19): cardContents(), cardRow(), clearFilter(), drawFlowList(), filteredFlows(), groupIsOpen(), groupTotal(), linkItem() (+11 more)

### Community 60 - "analyzer/stack.ts"
Cohesion: 0.13
Nodes (18): detectStack(), findManifests(), LOCKFILES, MARKER_FILES, record(), rel(), Rule, ruleFor() (+10 more)

### Community 61 - "testplan.ts"
Cohesion: 0.15
Nodes (18): DocGroup, DocLine, DocRow, StageKey, clip(), groupsOf(), ORDER, plain() (+10 more)

### Community 62 - "apps/api/src/orders/orders.service.ts"
Cohesion: 0.14
Nodes (5): Order, OrderDocument, OrderSchema, OrdersController, OrdersService

### Community 63 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, composite, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module (+10 more)

### Community 64 - "Architecture"
Cohesion: 0.11
Nodes (18): 3. Interpolated base URLs, Architecture, Evidence, not diagrams, Failing fast on configuration, Known limits, Matching the seam, Multi-root scanning, Phantom endpoints (+10 more)

### Community 65 - "@flowslens/cli"
Cohesion: 0.11
Nodes (17): 1. Scan, 2. Pick a feature and follow it, 3. Or click around instead, Commands, Documentation, First: will this work on my project?, @flowslens/cli, Install (+9 more)

### Community 66 - "relations.ts"
Cohesion: 0.24
Nodes (17): CollectionRelation, collectionRelations(), declaredRefs(), fieldNodeFor(), followedPathsIn(), inferredFromNames(), isSourceRef(), linkCollectionRelations() (+9 more)

### Community 67 - "sidebar.ts"
Cohesion: 0.23
Nodes (17): humanizeName(), pageRouteOf(), appNavigation, authPages(), authRank(), NavItem, normalizeRoute(), routeKey() (+9 more)

### Community 69 - "document.ts"
Cohesion: 0.21
Nodes (16): Added, Documentation, describeMismatch(), EVIDENCE_BADGE, padKind(), renderFeatureDocument(), renderFlowTree(), renderLineage() (+8 more)

### Community 70 - "servermodules.ts"
Cohesion: 0.21
Nodes (15): Classification, classifyFile(), CLIENT_MODULES, containsJsx(), importSpecifiers(), isFileSystemRoute(), isServerCandidate(), SERVER_DECORATORS (+7 more)

### Community 71 - "@flowslens/runtime"
Cohesion: 0.12
Nodes (16): Copy the block for your stack, Do you need this?, Documentation, Express (CommonJS — the `require()` style), Express (ESM), @flowslens/runtime, Install, Licence (+8 more)

### Community 72 - "runtime/src/index.ts"
Cohesion: 0.20
Nodes (12): globalRef, SPAN_HEADER, STORAGE_KEY, TRACE_HEADER, TraceContext, HttpTracerOptions, ServerTracingOptions, setSink() (+4 more)

### Community 73 - "smoke.mjs"
Cohesion: 0.22
Nodes (16): assertNoArtifactsIn(), BIN, check(), dashboard(), expectFailure(), fail(), flowlens(), indent() (+8 more)

### Community 74 - "Changelog"
Cohesion: 0.12
Nodes (15): [0.1.0] - 2026-08-24, [1.0.1] - 2026-09-09, [1.1.1] - 2026-09-15, [1.2.0] - 2026-09-30, [1.3.1] - 2026-10-05, Added, Added, Changed (+7 more)

### Community 75 - "Flowslens"
Cohesion: 0.12
Nodes (14): Any project structure, Development, flowlens.config.json, Flowslens, License, Packages, Project status, Repository layout (+6 more)

### Community 76 - "ImportsService"
Cohesion: 0.14
Nodes (6): ImportsController, ImportsService, Deliberate findings, Example: shop CRUD app, Layout, Try it

### Community 77 - "instrument.ts"
Cohesion: 0.16
Nodes (10): installCommand(), InstrumentArgs, mentions(), readManifest(), rel(), runInstrument(), SKIP, BIN (+2 more)

### Community 78 - "gitignore.test.ts"
Cohesion: 0.13
Nodes (6): BIN, git(), here, REPO, repository(), temp

### Community 79 - "commands/stack.ts"
Cohesion: 0.15
Nodes (6): describeShape(), note(), runStack(), StackArgs, project, report

### Community 80 - "mongoose.ts"
Cohesion: 0.23
Nodes (13): All exports, currentContext(), newId(), traceMethod(), writeSpan(), collectionOf(), DOCUMENT_HOOKS, flowlensMongoose() (+5 more)

### Community 82 - "customers.tsx"
Cohesion: 0.23
Nodes (9): api, CustomerForm(), OrderForm(), Product, CreateCustomerInput, useCreateCustomer(), Customer, CustomersPage() (+1 more)

### Community 83 - "pages.ts"
Cohesion: 0.23
Nodes (14): add(), buildPageIndex(), defaultImports(), FileIndex, FlowPage, FlowPagesOptions, namedImports(), pageOf() (+6 more)

### Community 84 - "@flowslens/core"
Cohesion: 0.14
Nodes (13): A complete first script, Do you want this package?, Documentation, Every way an action can go, Failing a CI job on findings, @flowslens/core, Install, Licence (+5 more)

### Community 85 - "PageIndex"
Cohesion: 0.19
Nodes (4): CardDataOptions, PageIndex, linkingFiles(), NavigationLinks

### Community 86 - "nextruntime.test.ts"
Cohesion: 0.19
Nodes (3): FakeCursor, spans(), traceFile()

### Community 87 - ".collection"
Cohesion: 0.19
Nodes (6): Adding support for a framework or database, Adapters, not special cases, Which collections, and what happened to them, FakeCollection, FakeDb, start()

### Community 88 - "aftermath.ts"
Cohesion: 0.26
Nodes (12): Aftermath, aftermathOf(), EMPTY, firstStringLike(), invalidatedKeys(), INVALIDATORS, isOnErrorCallback(), keyExpression() (+4 more)

### Community 90 - "src/http.ts"
Cohesion: 0.26
Nodes (9): withContext(), DEFAULT_IGNORE, flowlensHttp(), headerValue(), requestPath(), routePattern(), shouldIgnore(), TracedRequest (+1 more)

### Community 91 - "lib/models.ts"
Cohesion: 0.20
Nodes (6): Every action, including the ones that are not clicks, Stacks where the chain hides in the middle, What one action shows you, DELETE(), CustomerModel, OrderModel

### Community 92 - "browser.ts"
Cohesion: 0.31
Nodes (9): activeAction(), BrowserSpan, BrowserTracerOptions, clientSpan(), defaultEndpoint(), installBrowserTracer(), labelOf(), pathOf() (+1 more)

### Community 93 - "Roadmap"
Cohesion: 0.18
Nodes (10): Done — unreleased, Done — v1.0 (published), Explicit non-goals, Later — AI, More of the stack, Next, Not done, and it matters, Roadmap (+2 more)

### Community 94 - "config.ts"
Cohesion: 0.29
Nodes (10): CONFIG_FILENAMES, contains(), farRoots(), loadConfig(), loaded(), LoadedConfig, mergeConfig(), message() (+2 more)

### Community 95 - "mongodb.ts"
Cohesion: 0.24
Nodes (9): AnyFunction, AWAITED, CURSORS, isPromise(), TERMINALS, timed(), traceCollection(), traceDb() (+1 more)

### Community 96 - "server.cjs"
Cohesion: 0.18
Nodes (8): express, Item, mongoose, router, app, express, mongoose, Note

### Community 98 - "middleware.ts"
Cohesion: 0.24
Nodes (8): DECORATOR_ROLES, MIDDLEWARE_LABEL, MiddlewareInput, middlewareNames(), MiddlewareRole, PLUMBING, referencedName(), ids

### Community 99 - ".sorted"
Cohesion: 0.33
Nodes (6): baseName(), compareKeys(), fileOf(), lineOf(), SequenceOrder, sidebarEntries()

### Community 100 - "Contributing to Flowslens"
Cohesion: 0.22
Nodes (8): Before you open a PR, Commit messages, Contributing to Flowslens, Getting set up, How the code is laid out, Reporting a bug, Tests, The one rule that matters

### Community 101 - "analyzer/http.ts"
Cohesion: 0.28
Nodes (8): DetectedRequest, DYNAMIC_MARKER, HTTP_METHODS, HttpMethod, joinRoutePath(), normalizePath(), normalizeSegment(), PARAM

### Community 102 - "Install"
Cohesion: 0.22
Nodes (9): From source, If your terminal cannot draw boxes, Install, Naming a project, On your PATH, from a clone, Or install it once, Start on a project you have never scanned, The short way — no install at all (+1 more)

### Community 103 - "FlowslensConfig"
Cohesion: 0.29
Nodes (8): [1.1.0] - 2026-09-15, Changed, Changed, Fixed, Security, FileConfig, FlowLensConfig, FlowslensConfig

### Community 104 - "server.ts"
Cohesion: 0.32
Nodes (6): Done — v1.2 (published), register(), EmitArgs, globalRef, installServerTracing(), PATCHED

### Community 105 - "product.schema.ts"
Cohesion: 0.25
Nodes (3): Product, ProductDocument, ProductSchema

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

### Community 112 - "Commands"
Cohesion: 0.29
Nodes (7): Ask your AI assistant, answered from the graph, Commands, What a feature is called, What a pull request does to the app, What is already wrong here, What is this code for?, What nothing uses

### Community 113 - "[1.0.0] - 2026-08-31"
Cohesion: 0.33
Nodes (6): [1.0.0] - 2026-08-31, Added, Added, Fixed, Fixed, Packaging

### Community 114 - "Code of Conduct"
Cohesion: 0.33
Nodes (5): Code of Conduct, Enforcement, Expected behaviour, The short version, Unacceptable behaviour

### Community 115 - "List.tsx"
Cohesion: 0.60
Nodes (4): Following a call into the service layer, archiveCustomer(), fetchCustomers(), List()

### Community 116 - "cli/bin/flowlens.mjs"
Cohesion: 0.33
Nodes (3): code, current, MINIMUM_NODE

### Community 117 - "The three things you will actually do"
Cohesion: 0.33
Nodes (6): 1. List every feature that reaches the backend, 2. Ask what a line of code is for, 3. Ask what breaks if you change something, The three things you will actually do, What the graph contains, state()

### Community 118 - "Security Policy"
Cohesion: 0.33
Nodes (5): Reporting a vulnerability, Security Policy, Supported versions, Things to know, What Flowslens does with your code

### Community 121 - "[Unreleased]"
Cohesion: 0.50
Nodes (4): Added, Changed, Fixed, [Unreleased]

### Community 122 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.50
Nodes (3): Checklist, What this changes, Why

### Community 124 - "[1.1.2] - 2026-09-15"
Cohesion: 0.67
Nodes (3): [1.1.2] - 2026-09-15, Changed, Note

## Knowledge Gaps
- **9 isolated node(s):** `@types/node`, `eslint`, `jsdom`, `prettier`, `typescript` (+4 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 962 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Which collections, and what happened to them` connect `.collection` to `CustomersController`, `Flowslens`, `AdminService`, `carddata.test.ts`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `FlowGraph` (e.g. with `Main exports` and `What the graph contains`) actually correct?**
  _`FlowGraph` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@types/node`, `eslint`, `jsdom` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `packages_core_dist_index` be split into smaller, more focused modules?**
  _Cohesion score 0.029506948410432134 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `packages_core_dist_index` to `relations.test.ts`, `carddata.ts`, `carddata.test.ts`, `dashboard.test.ts`, `cli/src/index.ts`, `ref_node_path`, `instrument.ts`, `gitignore.test.ts`, `linkdecisions.ts`, `commands/stack.ts`, `package.json`, `portability.test.ts`, `nextruntime.test.ts`, `realworld.test.ts`, `tracer.test.ts`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.035527690700104496 - nodes in this community are weakly interconnected._
- **Why does `ts-morph` connect `src/scan.ts` to `packages_core_dist_index`, `action.ts`, `decisions.ts`, `carddata.ts`, `flow/findings.ts`, `frontend.ts`, `breakage.ts`, `linkdecisions.ts`, `backend.ts`, `actionsource.ts`, `SourceReader`, `nearestFunction`, `analyzer/unused.ts`, `unwrap`, `core/package.json`, `ast.ts`, `fileroutes.ts`, `callsequence.ts`, `navigation.ts`, `relations.ts`, `servermodules.ts`, `aftermath.ts`, `middleware.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._