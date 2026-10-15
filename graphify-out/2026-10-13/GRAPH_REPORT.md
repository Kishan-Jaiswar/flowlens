# Graph Report - flowlens  (2026-10-13)

## Corpus Check
- 245 files · ~380,274 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 7, .css 1, .cmd 1)

## Summary
- 3271 nodes · 8809 edges · 135 communities (116 shown, 19 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 505 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a2c25ee3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ref_node_path
- app.js
- action.ts
- explain.ts
- decisions.ts
- carddata.ts
- relations.test.ts
- serve.ts
- flow/findings.ts
- ref_node_url
- frontend.ts
- breakage.ts
- graph.ts
- linkdecisions.ts
- escapeHtml
- backend.ts
- init.ts
- package.json
- analyzer/unused.ts
- prisma.ts
- app.module.ts
- shop.service.ts
- literalText
- FeatureFlow
- renderTabs
- FlowGraph
- nextruntime.test.ts
- package-test.mjs
- cli/package.json
- nearestFunction
- [1.1.2] - 2026-09-15
- actionsource.ts
- scopeBadge
- src/scan.ts
- querydetail.ts
- core/src/index.ts
- commands/diff.ts
- carddata.test.ts
- core/package.json
- runtime/package.json
- cardDocsHtml
- fileRef
- renderPageStory
- document.ts
- api.ts
- shipments.service.ts
- dashboard.test.ts
- outline.ts
- SourceReader
- condense
- renderNode
- portability.test.ts
- SourcePoint
- screens.ts
- CustomerPanel.js
- realworld.test.ts
- callsequence.ts
- navigation.ts
- ast.ts
- analyzer/stack.ts
- testplan.ts
- apps/api/src/orders/orders.service.ts
- compilerOptions
- Architecture
- @flowslens/cli
- ImportsService
- sidebar.ts
- AdminService
- effects.ts
- config.ts
- @flowslens/runtime
- runtime/src/index.ts
- smoke.mjs
- Changelog
- Flowslens
- fileroutes.ts
- ref_react
- gitignore.test.ts
- commands/stack.ts
- mongoose.ts
- CustomersController
- customers.tsx
- pages.ts
- @flowslens/core
- NavigationLinks
- .collection
- relations.ts
- aftermath.ts
- ref_mongoose
- src/http.ts
- lib/models.ts
- browser.ts
- Roadmap
- [1.2.0] - 2026-09-30
- mongodb.ts
- server.cjs
- shareddecisions.ts
- shareddecisions.test.ts
- CreateCustomerDto
- Contributing to Flowslens
- actionDecisions
- Install
- Main exports
- CreateOrderDto
- labelTree
- cli/tsconfig.json
- TraceSink
- runtime/tsconfig.json
- CustomersController
- core/tsconfig.json
- .prettierrc.json
- server.ts
- [1.0.0] - 2026-08-31
- Code of Conduct
- List.tsx
- cli/bin/flowlens.mjs
- FlowslensConfig
- product.schema.ts
- main.ts
- Commands
- instrument.ts
- PULL_REQUEST_TEMPLATE.md
- server/models.ts
- crud/web/src/components/OrderForm.tsx
- Changed
- CLAUDE.md
- apps/web/src/components/OrderForm.tsx
- ownPart

## God Nodes (most connected - your core abstractions)
1. `escapeHtml()` - 88 edges
2. `unwrap()` - 80 edges
3. `condense()` - 71 edges
4. `FlowGraph` - 71 edges
5. `vitest` - 50 edges
6. `SourceReader` - 50 edges
7. `ts-morph` - 41 edges
8. `nearestFunction()` - 37 edges
9. `scan()` - 35 edges
10. `lineOf()` - 34 edges

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

## Communities (135 total, 19 thin omitted)

### Community 0 - "ref_node_path"
Cohesion: 0.03
Nodes (53): vitest, packages, root, roots, flows, project, result, save (+45 more)

### Community 1 - "app.js"
Cohesion: 0.04
Nodes (88): apiUrl(), applyZoom(), arrow(), bindDocBar(), breakItems(), cardContents(), cardRow(), CHANGE_LABELS (+80 more)

### Community 2 - "action.ts"
Cohesion: 0.07
Nodes (75): baseName(), bodyArgument(), callerParams(), checkedRows(), classifyExit(), classifyMiddleware(), code(), conditionText() (+67 more)

### Community 3 - "explain.ts"
Cohesion: 0.06
Nodes (79): RelationVia, ApiDataAccess, FlowAftermath, ActionData, aftermathCautions(), candidateFor(), capitalize(), cell() (+71 more)

### Community 4 - "decisions.ts"
Cohesion: 0.08
Nodes (83): bodyStatements(), functionOf(), unwrap(), branchingHelper(), cacheKeyWords(), callbackIn(), calledName(), calleeText() (+75 more)

### Community 5 - "carddata.ts"
Cohesion: 0.06
Nodes (67): around(), bindingPath(), binds(), CardCalculation, CardCondition, cardData, CardField, CardSource (+59 more)

### Community 6 - "relations.test.ts"
Cohesion: 0.09
Nodes (14): COMMANDS_WITH_ARGUMENT, COMMANDS_WITH_LOCATION, looksLikePath(), SOURCE_EXTENSIONS, SplitOptions, splitPositionals, scanned, exampleScan() (+6 more)

### Community 7 - "serve.ts"
Cohesion: 0.05
Nodes (81): withCommittedText(), FindingsArgs, paint(), RANK, render(), runFindings(), findFlow(), FlowArgs (+73 more)

### Community 8 - "flow/findings.ts"
Cohesion: 0.11
Nodes (44): authCallsIn(), BY_ID, checkLoops(), checkMassAssignment(), checkRoutes(), checkSequentialAwaits(), checkTenantFromRequest(), checkTenantScope() (+36 more)

### Community 9 - "ref_node_url"
Cohesion: 0.04
Nodes (27): clock, events, nextSpanId(), recordFlow(), root, cli, dashboard, root (+19 more)

### Community 10 - "frontend.ts"
Cohesion: 0.05
Nodes (84): calleeName(), callsIn(), functionName(), objectKeys(), stripQuotes(), isFrontendCandidate(), ACTION_PROPS, actionLabel() (+76 more)

### Community 11 - "breakage.ts"
Cohesion: 0.06
Nodes (61): analyzeBreakage(), analyzeGroup(), basenameOf(), BreakageInput, BreakageReport, BreakError, callArgs(), ChangedSymbol (+53 more)

### Community 12 - "graph.ts"
Cohesion: 0.09
Nodes (32): projectUnused, UnusedReport, ActionDoc, ScreenIndexEntry, ActionQuery, describe(), DETAIL_EDGES, hit() (+24 more)

### Community 13 - "linkdecisions.ts"
Cohesion: 0.20
Nodes (20): addressNames(), collectRequests(), enter(), escape(), evaluate(), evaluateNode(), fileMentions(), findLine() (+12 more)

### Community 14 - "escapeHtml"
Cohesion: 0.11
Nodes (55): actionIssuesHtml(), answer(), bindCopy(), bindFlowJumps(), bindIssueJumps(), bindProjectIssues(), bindStepSelection(), bindTableFolds() (+47 more)

### Community 15 - "backend.ts"
Cohesion: 0.13
Nodes (46): asObjectLiteral(), calleeMember(), calleeReceiver(), decoratorStringArg(), getDecorator(), lineOf(), readString(), analyzeBackend() (+38 more)

### Community 16 - "init.ts"
Cohesion: 0.09
Nodes (46): API_DIRS, buildConfig(), describeIgnore(), Detection, detectSetup(), displayPath(), findHalvesInside(), findSiblingRepositories() (+38 more)

### Community 17 - "package.json"
Cohesion: 0.04
Nodes (47): author, description, devDependencies, eslint, @eslint/js, globals, jsdom, prettier (+39 more)

### Community 18 - "analyzer/unused.ts"
Cohesion: 0.11
Nodes (25): ImportUse, BrokenImport, countWord(), ENTRY_PATTERNS, exportsOf(), filesUnder(), findUnused(), flattenExports() (+17 more)

### Community 19 - "prisma.ts"
Cohesion: 0.25
Nodes (10): CLIENT_HEADS, clientProperty(), EMPTY_SCHEMA, findSchemaFiles(), loadPrismaSchema(), PRISMA_OPERATIONS, PrismaRelation, readModels() (+2 more)

### Community 20 - "app.module.ts"
Cohesion: 0.09
Nodes (8): CustomersService, Order, OrderDocument, OrderSchema, OrdersController, OrdersService, ProductsController, ProductsService

### Community 21 - "shop.service.ts"
Cohesion: 0.12
Nodes (8): ShopController, ShopService, ShopSettings, ShopSettingsDocument, ShopSettingsSchema, StockMap, StockMapDocument, StockMapSchema

### Community 22 - "literalText"
Cohesion: 0.21
Nodes (21): branchRows(), contextRows(), decodeEntities(), derivedStates(), describeView(), fieldLabels(), isFormTrigger(), labelText() (+13 more)

### Community 23 - "FeatureFlow"
Cohesion: 0.08
Nodes (42): Added, Done since v1.0, EMPTY, findTestFiles(), FlowTests, indexTests(), isFile(), readCases() (+34 more)

### Community 24 - "renderTabs"
Cohesion: 0.14
Nodes (38): countLinks(), decisionsKey(), decisionsUrl(), findLink(), findNavEntry(), getJson(), isPageEntry(), linkFlowId() (+30 more)

### Community 25 - "FlowGraph"
Cohesion: 0.11
Nodes (25): linkStateRefetches(), lineageTargets(), linkDataLineage(), pruneQuerylessModules(), schemaOf(), attributeCallSites(), collectionAccesses(), distinctTitles() (+17 more)

### Community 26 - "nextruntime.test.ts"
Cohesion: 0.05
Nodes (17): bootstrap(), NestJS, EXAMPLE_ROOT, here, middleware, OrdersService, project, server (+9 more)

### Community 27 - "package-test.mjs"
Cohesion: 0.09
Nodes (27): argv, child, CLI_BIN, CLI_DIST, fail(), needsBuild(), newestSourceTime(), npm() (+19 more)

### Community 28 - "cli/package.json"
Cohesion: 0.06
Nodes (30): author, bin, flowlens, bugs, email, url, dependencies, @flowslens/core (+22 more)

### Community 29 - "nearestFunction"
Cohesion: 0.10
Nodes (39): callerOf(), componentOf(), handlersFromExpression(), locateCalls(), locateChild(), locateEntry(), nearestComponent(), openingSnippet() (+31 more)

### Community 30 - "[1.1.2] - 2026-09-15"
Cohesion: 0.67
Nodes (3): [1.1.2] - 2026-09-15, Changed, Note

### Community 31 - "actionsource.ts"
Cohesion: 0.11
Nodes (23): collectFrontSchemas(), objectFrom(), appliesOnlyWithMissing(), describeChain(), Env, EXTENSIONS, fill(), literal() (+15 more)

### Community 32 - "scopeBadge"
Cohesion: 0.22
Nodes (11): cardChecks(), cardDecisionTree(), cardOf(), formatMs(), impactBadge(), scopeActionIds(), scopeBadge(), scopeIssues() (+3 more)

### Community 33 - "src/scan.ts"
Cohesion: 0.06
Nodes (54): 1. Endpoint constants (`analyzer/constants.ts`), 3. Interpolated base URLs, Reading URLs the way real code writes them, enclosingFunction(), DEFAULT_BACKEND_CONFIG, collectConstants(), ConstantTable, emptyConstantTable() (+46 more)

### Community 34 - "querydetail.ts"
Cohesion: 0.40
Nodes (10): baseQueryCall(), chainAfter(), filterWords(), keysOf(), parallelName(), pipelineStages(), queryDetail(), resultName() (+2 more)

### Community 36 - "core/src/index.ts"
Cohesion: 0.07
Nodes (54): BackendIndex, DEFAULT_ACTION_PROPS, DEFAULT_INPUT_ACTION_PROPS, DetectedRequest, bestRouteMatch(), DYNAMIC_MARKER, HttpMethod, matchScore() (+46 more)

### Community 37 - "commands/diff.ts"
Cohesion: 0.12
Nodes (17): ChangedFile, changedFiles(), ChangedFilesResult, git(), statusOf(), unquote(), DiffArgs, escapeCell() (+9 more)

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
Cohesion: 0.09
Nodes (40): beforeYouChangeHtml(), cardBlock(), cardDocsHtml(), cardEndpoints(), cardImpactHtml(), cardPathHtml(), cardPerfHtml(), cardTestsHtml() (+32 more)

### Community 42 - "fileRef"
Cohesion: 0.12
Nodes (23): absolutePath(), atLine(), boxElement(), branchTone(), buildBlock(), buildSeq(), codeLine(), countInside() (+15 more)

### Community 43 - "renderPageStory"
Cohesion: 0.11
Nodes (27): actionKind(), actionName(), actionPlace(), actionStory(), dataName(), dataSentence(), featureCount(), flowItem() (+19 more)

### Community 44 - "document.ts"
Cohesion: 0.13
Nodes (23): Documentation, CHAINED_MODIFIERS, DB_EFFECT_LABEL, DB_EFFECT_ORDER, DB_OPERATIONS, DbAccess, IRREGULAR, pluralize() (+15 more)

### Community 45 - "api.ts"
Cohesion: 0.13
Nodes (24): LocatedAction, aftermathFor(), ApiCallDetail, ApiField, ApiRoute, asStrings(), describeWhen(), disambiguate() (+16 more)

### Community 46 - "shipments.service.ts"
Cohesion: 0.11
Nodes (5): Shipment, ShipmentDocument, ShipmentSchema, ShipmentsController, ShipmentsService

### Community 47 - "dashboard.test.ts"
Cohesion: 0.04
Nodes (40): McpArgs, Request, runMcp(), SUPPORTED, Tool, ToolError, grid(), renderUnused() (+32 more)

### Community 48 - "outline.ts"
Cohesion: 0.15
Nodes (28): arrayItems(), attribute(), bindMap(), childHeading(), componentFunction(), drawnWhen(), Env, functionOf() (+20 more)

### Community 49 - "SourceReader"
Cohesion: 0.13
Nodes (12): ExplainActionOptions, SourceReader, CardDataOptions, ActionDecisionsOptions, Ctx, FindingsOptions, LinkDecisionsOptions, AppNavigationOptions (+4 more)

### Community 50 - "condense"
Cohesion: 0.20
Nodes (23): backendSchemaChecks(), branchCalls(), businessExits(), classifyReaction(), ClientFacts, conditionsFor(), directCalls(), guardsIn() (+15 more)

### Community 51 - "renderNode"
Cohesion: 0.19
Nodes (14): codeList(), detailSection(), effectOf(), eventVerb(), renderActionHeader(), renderCollectionSummary(), renderFlowSummary(), renderNode() (+6 more)

### Community 52 - "portability.test.ts"
Cohesion: 0.10
Nodes (4): BIN, EXAMPLES, here, REPO

### Community 53 - "SourcePoint"
Cohesion: 0.10
Nodes (21): Functionish, CallContext, Confirmation, DbOp, FrontFn, GuardExit, GuardFacts, HeaderRow (+13 more)

### Community 54 - "screens.ts"
Cohesion: 0.13
Nodes (27): addMountActions(), componentPhrase(), opensOrCloses(), reachesApiCall(), ACRONYM_VALUES, ACRONYMS, basenameOf(), composeTitle() (+19 more)

### Community 55 - "CustomerPanel.js"
Cohesion: 0.22
Nodes (17): 2. Wrapper functions (`readWrapperCall`), Working with a real codebase, CustomerPanel(), createShipment, duplicated, getCustomerById, getCustomersList, getShopSettings (+9 more)

### Community 57 - "callsequence.ts"
Cohesion: 0.19
Nodes (19): addSetter(), argumentIdentifiers(), branchFacts(), calleeName(), callSequenceFacts, CONCURRENT, condense(), continuationDepth() (+11 more)

### Community 58 - "navigation.ts"
Cohesion: 0.16
Nodes (26): pageRouteOf(), appNavigation, AUTH_PAGES, authPages(), authRank(), CONTENT_KEYS, firstComponent(), flatten() (+18 more)

### Community 59 - "ast.ts"
Cohesion: 0.21
Nodes (13): propertyValue(), readInterpolation(), readPathLike(), bodyObject(), bodyObjectFrom(), buildRequest(), isHttpMethod(), queryKeysOf() (+5 more)

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
Cohesion: 0.12
Nodes (16): Architecture, Evidence, not diagrams, Failing fast on configuration, Known limits, Matching the seam, Multi-root scanning, Phantom endpoints, Prefixes must be stripped on both sides (+8 more)

### Community 65 - "@flowslens/cli"
Cohesion: 0.11
Nodes (17): 1. Scan, 2. Pick a feature and follow it, 3. Or click around instead, Commands, Documentation, First: will this work on my project?, @flowslens/cli, Install (+9 more)

### Community 66 - "ImportsService"
Cohesion: 0.14
Nodes (6): ImportsController, ImportsService, Deliberate findings, Example: shop CRUD app, Layout, Try it

### Community 67 - "sidebar.ts"
Cohesion: 0.21
Nodes (15): allActions(), appSidebar, baseName(), compareKeys(), fileOf(), isFieldEdit(), lineOf(), opensPart() (+7 more)

### Community 69 - "effects.ts"
Cohesion: 0.10
Nodes (23): EFFECT_LABEL, EffectKind, EffectMatch, EffectRule, hostOf(), HTTP_CALLERS, HTTP_VERBS, literalHead() (+15 more)

### Community 70 - "config.ts"
Cohesion: 0.29
Nodes (10): CONFIG_FILENAMES, contains(), farRoots(), loadConfig(), loaded(), LoadedConfig, mergeConfig(), message() (+2 more)

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
Cohesion: 0.17
Nodes (11): [0.1.0] - 2026-08-24, [1.0.1] - 2026-09-09, [1.1.1] - 2026-09-15, [1.3.1] - 2026-10-05, Added, Changed, Changelog, Fixed (+3 more)

### Community 75 - "Flowslens"
Cohesion: 0.12
Nodes (14): Any project structure, Development, flowlens.config.json, Flowslens, License, Packages, Project status, Repository layout (+6 more)

### Community 76 - "fileroutes.ts"
Cohesion: 0.13
Nodes (27): BackendConfig, Classification, classifyFile(), CLIENT_MODULES, containsJsx(), FileSide, importSpecifiers(), isFileSystemRoute() (+19 more)

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
Cohesion: 0.36
Nodes (6): api, CustomerForm(), CreateCustomerInput, useCreateCustomer(), Customer, CustomersPage()

### Community 83 - "pages.ts"
Cohesion: 0.22
Nodes (16): add(), buildPageIndex(), defaultImports(), FileIndex, FlowPage, flowPages(), namedImports(), NeedsProps (+8 more)

### Community 84 - "@flowslens/core"
Cohesion: 0.10
Nodes (20): 1. List every feature that reaches the backend, 2. Ask what a line of code is for, 3. Ask what breaks if you change something, A complete first script, Do you want this package?, Documentation, Every way an action can go, Failing a CI job on findings (+12 more)

### Community 86 - ".collection"
Cohesion: 0.19
Nodes (6): Adding support for a framework or database, Adapters, not special cases, Which collections, and what happened to them, FakeCollection, FakeDb, start()

### Community 87 - "relations.ts"
Cohesion: 0.24
Nodes (17): CollectionRelation, collectionRelations(), declaredRefs(), fieldNodeFor(), followedPathsIn(), inferredFromNames(), isSourceRef(), linkCollectionRelations() (+9 more)

### Community 88 - "aftermath.ts"
Cohesion: 0.20
Nodes (17): Aftermath, aftermathOf(), EMPTY, firstStringLike(), invalidatedKeys(), invalidatedPrefixes(), INVALIDATORS, isOnErrorCallback() (+9 more)

### Community 89 - "ref_mongoose"
Cohesion: 0.09
Nodes (10): AuditLog, AuditLogDocument, AuditLogSchema, AuditService, Customer, CustomerDocument, CustomerSchema, Customer (+2 more)

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

### Community 94 - "[1.2.0] - 2026-09-30"
Cohesion: 0.50
Nodes (4): [1.2.0] - 2026-09-30, Added, Changed, Fixed

### Community 95 - "mongodb.ts"
Cohesion: 0.24
Nodes (9): AnyFunction, AWAITED, CURSORS, isPromise(), TERMINALS, timed(), traceCollection(), traceDb() (+1 more)

### Community 96 - "server.cjs"
Cohesion: 0.18
Nodes (8): express, Item, mongoose, router, app, express, mongoose, Note

### Community 97 - "shareddecisions.ts"
Cohesion: 0.31
Nodes (15): countOf(), SharedUse, endsAll(), factorSharedDecisions(), identity(), indexSharedDecisions(), mapChildren(), prepared() (+7 more)

### Community 98 - "shareddecisions.test.ts"
Cohesion: 0.18
Nodes (11): Added, Changed, Fixed, [Unreleased], DecisionGroup, DecisionStep, sharedPartTree(), at() (+3 more)

### Community 100 - "Contributing to Flowslens"
Cohesion: 0.22
Nodes (8): Before you open a PR, Commit messages, Contributing to Flowslens, Getting set up, How the code is laid out, Reporting a bug, Tests, The one rule that matters

### Community 101 - "actionDecisions"
Cohesion: 0.18
Nodes (11): actionDecisions, DecisionNode, DecisionSide, effectsIndex(), markUncaught(), pageOpened(), reachedThroughState(), triggerText() (+3 more)

### Community 102 - "Install"
Cohesion: 0.22
Nodes (9): From source, If your terminal cannot draw boxes, Install, Naming a project, On your PATH, from a clone, Or install it once, Start on a project you have never scanned, The short way — no install at all (+1 more)

### Community 103 - "Main exports"
Cohesion: 0.14
Nodes (21): Main exports, pageAtPath(), resolveFlows(), createProject(), AffectedFeature, analyzeChanged(), ChangedInput, ChangedReport (+13 more)

### Community 105 - "labelTree"
Cohesion: 0.38
Nodes (10): capitalise(), codeQuestionLabel(), endLabel(), groupLabel(), labelTree(), looksLikeCode(), pageNavigation(), questionLabel() (+2 more)

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

### Community 112 - "server.ts"
Cohesion: 0.32
Nodes (6): Done — v1.2 (published), register(), EmitArgs, globalRef, installServerTracing(), PATCHED

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

### Community 117 - "FlowslensConfig"
Cohesion: 0.29
Nodes (8): [1.1.0] - 2026-09-15, Changed, Changed, Fixed, Security, FileConfig, FlowLensConfig, FlowslensConfig

### Community 118 - "product.schema.ts"
Cohesion: 0.25
Nodes (3): Product, ProductDocument, ProductSchema

### Community 120 - "Commands"
Cohesion: 0.29
Nodes (7): Ask your AI assistant, answered from the graph, Commands, What a feature is called, What a pull request does to the app, What is already wrong here, What is this code for?, What nothing uses

### Community 121 - "instrument.ts"
Cohesion: 0.39
Nodes (7): installCommand(), InstrumentArgs, mentions(), readManifest(), rel(), runInstrument(), SKIP

### Community 122 - "PULL_REQUEST_TEMPLATE.md"
Cohesion: 0.50
Nodes (3): Checklist, What this changes, Why

### Community 124 - "crud/web/src/components/OrderForm.tsx"
Cohesion: 0.60
Nodes (3): OrderForm(), Product, OrdersPage()

### Community 125 - "Changed"
Cohesion: 0.50
Nodes (4): [1.3.0] - 2026-10-05, Added, Changed, Fixed

### Community 134 - "ownPart"
Cohesion: 0.67
Nodes (3): hasMark(), hasQuery(), ownPart()

## Knowledge Gaps
- **9 isolated node(s):** `@types/node`, `eslint`, `jsdom`, `prettier`, `typescript` (+4 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 980 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `ref_node_path` to `shareddecisions.test.ts`, `carddata.ts`, `carddata.test.ts`, `serve.ts`, `relations.test.ts`, `ref_node_url`, `gitignore.test.ts`, `dashboard.test.ts`, `commands/stack.ts`, `package.json`, `portability.test.ts`, `realworld.test.ts`, `nextruntime.test.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `FlowGraph` (e.g. with `Main exports` and `What the graph contains`) actually correct?**
  _`FlowGraph` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@types/node`, `eslint`, `jsdom` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ref_node_path` be split into smaller, more focused modules?**
  _Cohesion score 0.02581191156246694 - nodes in this community are weakly interconnected._
- **Why does `scan()` connect `src/scan.ts` to `Architecture`, `@flowslens/cli`, `core/src/index.ts`, `Main exports`, `Changelog`, `frontend.ts`, `document.ts`, `fileroutes.ts`, `backend.ts`, `analyzer/unused.ts`, `prisma.ts`, `@flowslens/core`, `FlowslensConfig`, `relations.ts`, `FeatureFlow`, `FlowGraph`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.037027579162410625 - nodes in this community are weakly interconnected._
- **Why does `ts-morph` connect `condense` to `ref_node_path`, `action.ts`, `decisions.ts`, `carddata.ts`, `flow/findings.ts`, `frontend.ts`, `breakage.ts`, `linkdecisions.ts`, `backend.ts`, `analyzer/unused.ts`, `literalText`, `nearestFunction`, `actionsource.ts`, `src/scan.ts`, `querydetail.ts`, `core/package.json`, `outline.ts`, `callsequence.ts`, `navigation.ts`, `ast.ts`, `effects.ts`, `fileroutes.ts`, `relations.ts`, `aftermath.ts`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._