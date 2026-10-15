# Graph Report - flowlens  (2026-10-14)

## Corpus Check
- 246 files · ~405,266 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 7, .css 1, .cmd 1)

## Summary
- 3339 nodes · 9078 edges · 127 communities (111 shown, 16 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 519 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a2c25ee3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- packages_core_dist_index_resolveflows
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
- answer
- backend.ts
- init.ts
- package.json
- graph.ts
- merge.ts
- app.module.ts
- shop.service.ts
- actionsource.ts
- cardDocsHtml
- renderTabs
- condense
- dashboard.test.ts
- package-test.mjs
- cli/package.json
- queries.ts
- serve.ts
- api.ts
- nameOf
- dbaccess.ts
- unwrap
- ref_axios
- packages_core_dist_index
- commands/diff.ts
- auditaccuracy.test.ts
- core/package.json
- runtime/package.json
- escapeHtml
- renderGroup
- renderPageStory
- servermodules.ts
- FlowGraph
- shipments.service.ts
- fileroutes.ts
- outline.ts
- SourceReader
- resolve.ts
- renderDetails
- labelTree
- src/scan.ts
- screens.ts
- CustomerPanel.js
- document.ts
- callsequence.ts
- navigation.ts
- lineOf
- analyzer/stack.ts
- testplan.ts
- apps/api/src/orders/orders.service.ts
- compilerOptions
- Architecture
- @flowslens/cli
- ImportsService
- sidebar.ts
- AdminService
- .collection
- config.ts
- @flowslens/runtime
- runtime/src/index.ts
- smoke.mjs
- Changelog
- Flowslens
- ast.ts
- readHttpCall
- gitignore.test.ts
- server.ts
- mongoose.ts
- CustomersController
- ref_react
- pages.ts
- @flowslens/core
- NavigationLinks
- tracer.test.ts
- relations.ts
- aftermath.ts
- ref_mongoose
- src/http.ts
- lib/models.ts
- browser.ts
- Roadmap
- nextruntime.test.ts
- mongodb.ts
- server.cjs
- Changed
- prepack.mjs
- CreateCustomerDto
- Contributing to Flowslens
- [1.2.0] - 2026-09-30
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
2. `unwrap()` - 84 edges
3. `condense()` - 78 edges
4. `FlowGraph` - 71 edges
5. `vitest` - 51 edges
6. `SourceReader` - 50 edges
7. `ts-morph` - 43 edges
8. `nearestFunction()` - 41 edges
9. `nameOf()` - 36 edges
10. `scan()` - 36 edges

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

## Communities (127 total, 16 thin omitted)

### Community 0 - "packages_core_dist_index_resolveflows"
Cohesion: 0.06
Nodes (21): flows, project, scanned, text, project, scanned, text, tree (+13 more)

### Community 1 - "app.js"
Cohesion: 0.04
Nodes (83): absolutePath(), apiUrl(), applyZoom(), arrow(), bindDocBar(), boxElement(), branchTone(), buildBlock() (+75 more)

### Community 2 - "action.ts"
Cohesion: 0.05
Nodes (87): Functionish, baseName(), bodyArgument(), CallContext, checkedRows(), classifyExit(), classifyMiddleware(), code() (+79 more)

### Community 3 - "explain.ts"
Cohesion: 0.06
Nodes (75): ActionData, aftermathCautions(), candidateFor(), capitalize(), cell(), CHECK_ROLE, checkRole(), componentName() (+67 more)

### Community 4 - "decisions.ts"
Cohesion: 0.08
Nodes (84): swallows(), bodyStatements(), functionOf(), blobErrorNote(), branchingHelper(), callbackIn(), calleeText(), CallKind (+76 more)

### Community 5 - "carddata.ts"
Cohesion: 0.06
Nodes (69): argumentsAt(), around(), asking(), bindingPath(), binds(), CardCalculation, CardCondition, cardData (+61 more)

### Community 6 - "portability.test.ts"
Cohesion: 0.10
Nodes (4): BIN, EXAMPLES, here, REPO

### Community 7 - "cli/src/index.ts"
Cohesion: 0.06
Nodes (53): FindingsArgs, paint(), RANK, render(), runFindings(), findFlow(), FlowArgs, FlowsArgs (+45 more)

### Community 8 - "flow/findings.ts"
Cohesion: 0.11
Nodes (42): BY_ID, checkLoops(), checkMassAssignment(), checkRoutes(), checkSequentialAwaits(), checkTenantFromRequest(), checkTenantScope(), chooseTenantKey() (+34 more)

### Community 9 - "ref_node_path"
Cohesion: 0.02
Nodes (51): clock, events, nextSpanId(), recordFlow(), root, packages, root, result (+43 more)

### Community 10 - "frontend.ts"
Cohesion: 0.07
Nodes (64): calleeName(), ACTION_PROPS, actionLabel(), ActionProps, aftermathMeta(), analyzeComponentBody(), analyzeFrontendFile(), argumentNames() (+56 more)

### Community 11 - "breakage.ts"
Cohesion: 0.06
Nodes (60): analyzeGroup(), basenameOf(), BreakageInput, BreakageReport, BreakError, callArgs(), ChangedSymbol, changeWeight() (+52 more)

### Community 12 - "core/src/index.ts"
Cohesion: 0.06
Nodes (58): BackendIndex, EFFECT_LABEL, EffectKind, DEFAULT_ACTION_PROPS, DEFAULT_INPUT_ACTION_PROPS, MIDDLEWARE_LABEL, MiddlewareRole, DbEffect (+50 more)

### Community 13 - "linkdecisions.ts"
Cohesion: 0.08
Nodes (51): Fixed, countOf(), DecisionGroup, DecisionNode, DecisionSide, DecisionStep, markUncaught(), SharedUse (+43 more)

### Community 14 - "answer"
Cohesion: 0.09
Nodes (51): actionIssuesHtml(), answer(), bindCopy(), bindFlowJumps(), bindIssueJumps(), bindProjectIssues(), bindStepSelection(), bindTableFolds() (+43 more)

### Community 15 - "backend.ts"
Cohesion: 0.16
Nodes (29): asObjectLiteral(), decoratorStringArg(), getDecorator(), readString(), analyzeBackend(), baseTypeName(), ClassInfo, ClassRole (+21 more)

### Community 16 - "init.ts"
Cohesion: 0.09
Nodes (44): API_DIRS, buildConfig(), describeIgnore(), Detection, detectSetup(), displayPath(), findHalvesInside(), findSiblingRepositories() (+36 more)

### Community 17 - "package.json"
Cohesion: 0.04
Nodes (47): author, description, devDependencies, eslint, @eslint/js, globals, jsdom, prettier (+39 more)

### Community 18 - "graph.ts"
Cohesion: 0.08
Nodes (34): BrokenImport, countWord(), ENTRY_PATTERNS, exportsOf(), filesUnder(), findUnused(), flattenExports(), IMPLICIT_WITH (+26 more)

### Community 19 - "merge.ts"
Cohesion: 0.09
Nodes (32): bestRouteMatch(), DYNAMIC_MARKER, matchScore(), normalizeSegment(), PARAM, RouteLike, routeMatches(), CHAINED_MODIFIERS (+24 more)

### Community 20 - "app.module.ts"
Cohesion: 0.09
Nodes (8): CustomersService, Order, OrderDocument, OrderSchema, OrdersController, OrdersService, ProductsController, ProductsService

### Community 21 - "shop.service.ts"
Cohesion: 0.12
Nodes (8): ShopController, ShopService, ShopSettings, ShopSettingsDocument, ShopSettingsSchema, StockMap, StockMapDocument, StockMapSchema

### Community 22 - "actionsource.ts"
Cohesion: 0.07
Nodes (41): collectFrontSchemas(), confirmTexts(), fieldLabels(), labelText(), navigationIn(), objectFrom(), toastText(), appliesOnlyWithMissing() (+33 more)

### Community 23 - "cardDocsHtml"
Cohesion: 0.19
Nodes (19): cardBlock(), cardDocsHtml(), cardEndpoints(), cardImpactHtml(), cardPathHtml(), cardPerfHtml(), cardTestsHtml(), fieldList() (+11 more)

### Community 24 - "renderTabs"
Cohesion: 0.12
Nodes (41): cardOf(), countLinks(), decisionsKey(), decisionsUrl(), featureCount(), findLink(), findNavEntry(), getJson() (+33 more)

### Community 25 - "condense"
Cohesion: 0.13
Nodes (39): backendSchemaChecks(), businessExits(), callerOf(), callerParams(), classifyReaction(), conditionsFor(), conditionText(), directCalls() (+31 more)

### Community 26 - "dashboard.test.ts"
Cohesion: 0.05
Nodes (28): McpArgs, Request, runMcp(), SUPPORTED, Tool, ToolError, apiResponse(), entryActions() (+20 more)

### Community 27 - "package-test.mjs"
Cohesion: 0.08
Nodes (28): argv, child, CLI_BIN, CLI_DIST, fail(), needsBuild(), newestSourceTime(), npm() (+20 more)

### Community 28 - "cli/package.json"
Cohesion: 0.06
Nodes (30): author, bin, flowlens, bugs, email, url, dependencies, @flowslens/core (+22 more)

### Community 29 - "queries.ts"
Cohesion: 0.17
Nodes (18): callAtLine(), actionQueries, ActionQueriesOptions, additionsTo(), argsText(), dedent(), dedupe(), explainVariable() (+10 more)

### Community 30 - "serve.ts"
Cohesion: 0.06
Nodes (44): runScan(), ScanArgs, answerLater(), browserCommand(), buildGraph(), collectSpans(), deny(), displayHost() (+36 more)

### Community 31 - "api.ts"
Cohesion: 0.13
Nodes (24): aftermathFor(), ApiDataAccess, ApiField, ApiRoute, asStrings(), describeWhen(), disambiguate(), FlowAftermath (+16 more)

### Community 32 - "nameOf"
Cohesion: 0.12
Nodes (39): branchRows(), componentOf(), contextRows(), decodeEntities(), derivedStates(), describeView(), eventOn(), isFormTrigger() (+31 more)

### Community 33 - "dbaccess.ts"
Cohesion: 0.13
Nodes (31): calleeMember(), calleeReceiver(), callsIn(), declareExpressRoutes(), findRouterNames(), resolveMethodBodies(), resolveModelReceiver(), collectionFor() (+23 more)

### Community 34 - "unwrap"
Cohesion: 0.33
Nodes (14): branchCalls(), ClientFacts, headerLines(), unwrap(), baseQueryCall(), chainAfter(), filterWords(), keysOf() (+6 more)

### Community 36 - "packages_core_dist_index"
Cohesion: 0.03
Nodes (25): COMMANDS_WITH_ARGUMENT, COMMANDS_WITH_LOCATION, looksLikePath(), SOURCE_EXTENSIONS, SplitOptions, splitPositionals, vitest, flows (+17 more)

### Community 37 - "commands/diff.ts"
Cohesion: 0.11
Nodes (18): ChangedFile, changedFiles(), ChangedFilesResult, git(), statusOf(), unquote(), withCommittedText(), DiffArgs (+10 more)

### Community 38 - "auditaccuracy.test.ts"
Cohesion: 0.05
Nodes (23): doc(), flowNamed(), flows, { graph }, labels(), project, reader, app (+15 more)

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
Nodes (20): cardContents(), cardRow(), clearFilter(), destination(), drawFlowList(), filteredFlows(), groupIsOpen(), groupTotal() (+12 more)

### Community 43 - "renderPageStory"
Cohesion: 0.16
Nodes (21): actionKind(), actionName(), actionPlace(), actionStory(), dataName(), dataSentence(), flowItem(), flowTitle() (+13 more)

### Community 44 - "servermodules.ts"
Cohesion: 0.19
Nodes (16): Classification, classifyFile(), CLIENT_MODULES, containsJsx(), FileSide, importSpecifiers(), isFileSystemRoute(), isFrontendCandidate() (+8 more)

### Community 45 - "FlowGraph"
Cohesion: 0.09
Nodes (39): actionPropsOf(), addMountActions(), analyzeFrontend(), debouncedStates(), distinguishTwins(), gateOf(), linkEffectRefetches(), linkPopupFeatures() (+31 more)

### Community 46 - "shipments.service.ts"
Cohesion: 0.11
Nodes (5): Shipment, ShipmentDocument, ShipmentSchema, ShipmentsController, ShipmentsService

### Community 47 - "fileroutes.ts"
Cohesion: 0.14
Nodes (22): BackendConfig, CollectionAliases, analyzeFileRoutes(), declareHandler(), declareVerbHandler(), FileRouteConfig, isHttpMethod(), methodsOf() (+14 more)

### Community 48 - "outline.ts"
Cohesion: 0.13
Nodes (32): arrayItems(), attribute(), bindMap(), childHeading(), componentFunction(), containsJsx(), drawnWhen(), Env (+24 more)

### Community 49 - "SourceReader"
Cohesion: 0.15
Nodes (11): ExplainActionOptions, SourceReader, CardDataOptions, ActionDecisionsOptions, Ctx, FindingsOptions, LinkDecisionsOptions, AppNavigationOptions (+3 more)

### Community 50 - "resolve.ts"
Cohesion: 0.16
Nodes (17): componentPhrase(), isGenericComponentName(), attributeCallSites(), CLICKS_TRACED, clicksTraced(), collectionAccesses(), distinctTitles(), executionOrder() (+9 more)

### Community 51 - "renderDetails"
Cohesion: 0.27
Nodes (12): effectOf(), eventVerb(), renderActionHeader(), renderCollectionSummary(), renderColumns(), renderDetails(), renderGraph(), renderNode() (+4 more)

### Community 52 - "labelTree"
Cohesion: 0.17
Nodes (19): cacheKeyWords(), calledName(), capitalise(), codeQuestionLabel(), endLabel(), findIn(), groupLabel(), isConfirm() (+11 more)

### Community 53 - "src/scan.ts"
Cohesion: 0.07
Nodes (46): Changed, Changed, DEFAULT_BACKEND_CONFIG, collectConstants(), ConstantTable, emptyConstantTable(), stringConstantsIn(), collectionAliasesOf() (+38 more)

### Community 54 - "screens.ts"
Cohesion: 0.17
Nodes (20): ACRONYM_VALUES, ACRONYMS, basenameOf(), featureFolderOf(), FRAMEWORK_FILES, GENERIC_DIRS, humanizeName(), isMeaningfulSegment() (+12 more)

### Community 55 - "CustomerPanel.js"
Cohesion: 0.22
Nodes (17): 2. Wrapper functions (`readWrapperCall`), Working with a real codebase, CustomerPanel(), createShipment, duplicated, getCustomerById, getCustomersList, getShopSettings (+9 more)

### Community 56 - "document.ts"
Cohesion: 0.23
Nodes (14): Documentation, DB_EFFECT_ORDER, describeMismatch(), EVIDENCE_BADGE, padKind(), renderFeatureDocument(), renderFlowTree(), RenderOptions (+6 more)

### Community 57 - "callsequence.ts"
Cohesion: 0.19
Nodes (19): addSetter(), argumentIdentifiers(), branchFacts(), calleeName(), callSequenceFacts, CONCURRENT, condense(), continuationDepth() (+11 more)

### Community 58 - "navigation.ts"
Cohesion: 0.16
Nodes (27): pageRouteOf(), appNavigation, AUTH_PAGES, authPages(), authRank(), componentFile(), CONTENT_KEYS, firstComponent() (+19 more)

### Community 59 - "lineOf"
Cohesion: 0.31
Nodes (12): lineOf(), addMiddleware(), DECORATOR_ROLES, linkExpressMiddleware(), linkNestConsumerMiddleware(), linkNestMiddleware(), MiddlewareInput, middlewareNames() (+4 more)

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
Nodes (19): 1. Endpoint constants (`analyzer/constants.ts`), 3. Interpolated base URLs, Architecture, Evidence, not diagrams, Failing fast on configuration, Known limits, Matching the seam, Multi-root scanning (+11 more)

### Community 65 - "@flowslens/cli"
Cohesion: 0.11
Nodes (17): 1. Scan, 2. Pick a feature and follow it, 3. Or click around instead, Commands, Documentation, First: will this work on my project?, @flowslens/cli, Install (+9 more)

### Community 66 - "ImportsService"
Cohesion: 0.14
Nodes (6): ImportsController, ImportsService, Deliberate findings, Example: shop CRUD app, Layout, Try it

### Community 67 - "sidebar.ts"
Cohesion: 0.16
Nodes (21): OutlineNode, flowPages(), pagesOfFile(), pageTitle(), allActions(), appSidebar, baseName(), compareKeys() (+13 more)

### Community 69 - ".collection"
Cohesion: 0.16
Nodes (8): Adding support for a framework or database, Adapters, not special cases, Which collections, and what happened to them, card(), read(), FakeCollection, FakeDb, start()

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
Cohesion: 0.08
Nodes (23): [0.1.0] - 2026-08-24, [1.0.0] - 2026-08-31, [1.0.1] - 2026-09-09, [1.1.0] - 2026-09-15, [1.1.1] - 2026-09-15, [1.3.1] - 2026-10-05, Added, Added (+15 more)

### Community 75 - "Flowslens"
Cohesion: 0.12
Nodes (14): Any project structure, Development, flowlens.config.json, Flowslens, License, Packages, Project status, Repository layout (+6 more)

### Community 76 - "ast.ts"
Cohesion: 0.19
Nodes (14): enclosingFunction(), functionName(), readInterpolation(), stripQuotes(), ownerComponentName(), ownerOf(), providedMembers(), providedObject() (+6 more)

### Community 77 - "readHttpCall"
Cohesion: 0.29
Nodes (13): objectKeys(), propertyValue(), readPathLike(), bodyObject(), bodyObjectFrom(), buildRequest(), isHttpMethod(), queryKeysOf() (+5 more)

### Community 78 - "gitignore.test.ts"
Cohesion: 0.14
Nodes (4): BIN, here, REPO, temp

### Community 79 - "server.ts"
Cohesion: 0.32
Nodes (6): Done — v1.2 (published), register(), EmitArgs, globalRef, installServerTracing(), PATCHED

### Community 80 - "mongoose.ts"
Cohesion: 0.23
Nodes (13): All exports, currentContext(), newId(), traceMethod(), writeSpan(), collectionOf(), DOCUMENT_HOOKS, flowlensMongoose() (+5 more)

### Community 82 - "ref_react"
Cohesion: 0.16
Nodes (9): api, CustomerForm(), OrderForm(), Product, CreateCustomerInput, useCreateCustomer(), Customer, CustomersPage() (+1 more)

### Community 83 - "pages.ts"
Cohesion: 0.23
Nodes (14): add(), buildPageIndex(), defaultImports(), FileIndex, FlowPage, FlowPagesOptions, namedImports(), NeedsProps (+6 more)

### Community 84 - "@flowslens/core"
Cohesion: 0.11
Nodes (18): 1. List every feature that reaches the backend, 2. Ask what a line of code is for, 3. Ask what breaks if you change something, A complete first script, Do you want this package?, Documentation, Failing a CI job on findings, @flowslens/core (+10 more)

### Community 86 - "tracer.test.ts"
Cohesion: 0.07
Nodes (11): bootstrap(), NestJS, middleware, OrdersService, project, server, service, sink (+3 more)

### Community 87 - "relations.ts"
Cohesion: 0.24
Nodes (16): CollectionRelation, collectionRelations(), declaredRefs(), fieldNodeFor(), followedPathsIn(), inferredFromNames(), isSourceRef(), linkCollectionRelations() (+8 more)

### Community 88 - "aftermath.ts"
Cohesion: 0.21
Nodes (18): Aftermath, aftermathOf(), EMPTY, firstStringLike(), invalidatedKeys(), invalidatedPrefixes(), INVALIDATORS, isOnErrorCallback() (+10 more)

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

### Community 94 - "nextruntime.test.ts"
Cohesion: 0.19
Nodes (3): FakeCursor, spans(), traceFile()

### Community 95 - "mongodb.ts"
Cohesion: 0.24
Nodes (9): AnyFunction, AWAITED, CURSORS, isPromise(), TERMINALS, timed(), traceCollection(), traceDb() (+1 more)

### Community 96 - "server.cjs"
Cohesion: 0.18
Nodes (8): express, Item, mongoose, router, app, express, mongoose, Note

### Community 97 - "Changed"
Cohesion: 0.18
Nodes (11): [1.1.2] - 2026-09-15, [1.3.0] - 2026-10-05, Added, Changed, Changed, Fixed, Note, Every way an action can go (+3 more)

### Community 98 - "prepack.mjs"
Cohesion: 0.25
Nodes (5): cli, dashboard, root, staged, tracer

### Community 100 - "Contributing to Flowslens"
Cohesion: 0.22
Nodes (8): Before you open a PR, Commit messages, Contributing to Flowslens, Getting set up, How the code is laid out, Reporting a bug, Tests, The one rule that matters

### Community 101 - "[1.2.0] - 2026-09-30"
Cohesion: 0.50
Nodes (4): [1.2.0] - 2026-09-30, Added, Changed, Fixed

### Community 102 - "Install"
Cohesion: 0.22
Nodes (9): From source, If your terminal cannot draw boxes, Install, Naming a project, On your PATH, from a clone, Or install it once, Start on a project you have never scanned, The short way — no install at all (+1 more)

### Community 103 - "Main exports"
Cohesion: 0.05
Nodes (67): Added, Done since v1.0, Main exports, EMPTY, findTestFiles(), FlowTests, indexTests(), isFile() (+59 more)

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
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 991 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ts-morph` connect `actionsource.ts` to `action.ts`, `decisions.ts`, `carddata.ts`, `flow/findings.ts`, `frontend.ts`, `breakage.ts`, `linkdecisions.ts`, `backend.ts`, `graph.ts`, `merge.ts`, `condense`, `queries.ts`, `dbaccess.ts`, `unwrap`, `packages_core_dist_index`, `core/package.json`, `servermodules.ts`, `fileroutes.ts`, `outline.ts`, `src/scan.ts`, `callsequence.ts`, `navigation.ts`, `lineOf`, `ast.ts`, `relations.ts`, `aftermath.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `FlowGraph` (e.g. with `Main exports` and `What the graph contains`) actually correct?**
  _`FlowGraph` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@types/node`, `eslint`, `jsdom` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `packages_core_dist_index_resolveflows` be split into smaller, more focused modules?**
  _Cohesion score 0.05641025641025641 - nodes in this community are weakly interconnected._
- **Why does `Flowslens` connect `Flowslens` to `.collection`, `Install`, `Main exports`, `CustomerPanel.js`, `Commands`, `lib/models.ts`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.03671830177854274 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `packages_core_dist_index` to `packages_core_dist_index_resolveflows`, `carddata.ts`, `auditaccuracy.test.ts`, `portability.test.ts`, `ref_node_path`, `linkdecisions.ts`, `gitignore.test.ts`, `package.json`, `tracer.test.ts`, `nextruntime.test.ts`, `dashboard.test.ts`, `serve.ts`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._