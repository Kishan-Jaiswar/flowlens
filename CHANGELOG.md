# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-10-15

### Added

- **A card that only shows data has its six tabs too.** "97% Stock health" is
  followed back through what the code says: `pct` is worked out from `inStock`
  and `total`, those from `data.lowStockCount` and two other fields, `data` is
  a prop handed down twice from the page's `useDashboard()`, that hook is
  `GET /dashboard`, and the server builds `lowStockCount` in an aggregation's
  `$sum`. Selecting the card shows, in Docs, how the data gets here, where the
  server makes each field, what the browser works out and what each value is
  drawn as; in Decisions, what decides whether and how it is drawn (the page
  waiting for its data, a Good / Fair / Low status, an empty list); in Issues &
  impact, the fields it depends on and the other cards that read them. The
  load that brings the data is stacked under it in every tab. A link inside a
  card — the "3,391 Low" tile — is read for the number it shows first, the
  one tile it stands for, and then for what clicking it does (`/api/card`).
- **The sidebar is a copy of the app's own.** When the app writes its menu
  down as data — `[{ name: "Billing", link: BILLING }, …]` mapped over by a side
  menu — `serve` reads it (following `link` through imported constants) and the
  dashboard's sidebar becomes that menu, in its order, with every action in the
  app placed in it:
  - each screen is laid out top to bottom, read from its JSX: what runs as it
    opens, then every control, and each card, panel or dialog — named by the
    title it shows (`title="Needs attention"`, `<CardTitle>Expiring soon`) —
    as a child entry holding its own loads, controls and links;
  - links are rows too ("View all → Stock History", the Low / Stockout /
    Expiring tiles spelled out from the array they are mapped from, "each row
    → Medicines › Details"), and clicking one opens the screen it leads to;
  - actions that never reach the backend (a filter, a field, opening a dialog)
    are listed by default — "include local-only actions" starts checked;
  - a sub-entry that picks a tab (`{ name: "Timing", tab: 1 }`) holds the
    actions of the component that tab shows;
  - screens the menu does not open are nested under the screen that leads to
    them — by route (`/medicines/[id]` under _Medicines_) or by a navigation on
    it (`router.push(\`/patient_detail/${id}\`)`, `<Link href>`, through route
    constants); one opened from several screens is listed under each;
  - the menu's own buttons ("+ Add Walk-In") are rows at the top, parts on most
    screens (a header, a right-hand panel) are one "Header & layout" entry, and
    login, sign-up and password pages come first;
  - only screens nothing links to end up in "Other screens" at the bottom.
  - clicking a page in the sidebar explains it in plain words instead of tabs:
    what it is, what it fetches by itself when it opens, then every thing the
    user can do on it from top to bottom, card by card — "You fill in Phone
    number and One-time password. You click "Send OTP". The app first checks
    what was entered… You see an error if you tried too many times in a row.
    When it works, a pop-up message confirms it." — read off each action's
    document, with data named in words (`clinicsettings` is "clinic
    settings"), where its links go, and the pages it leads to;
  - what is on a page — an action, a card, a dialog, a settings tab — has the
    six tabs: a card's show each of its actions' own tab in full, one after
    another in screen order. `#entry=<key>` links to any of them
    (`/api/scope` in `serve`, new `scopeSummary()` in `@flowslens/core`, for
    the header and tab badges);
  - a link row's six tabs are the flow it sets off, in full — what the screen
    it opens runs as it opens (_Low_ is _Medicines view loads_, reached with
    `stockFilter=low-stock`) — with what the click does said above the steps;
  - a link's Decisions tab draws only that link's feature: the click, the
    address it opens, where the page reads the value (`stockFilter`), the one
    request that carries it, the sign-in check, the server's check on the value
    and the branch it picks — "low-stock — this link", with the other cases
    marked "Not for this link" — then the queries and what the page shows. The
    page's other requests and the API client around every call are left to the
    page's tabs (`linkDecisions()` in `@flowslens/core`; `/api/decisions` takes
    `link`, `label`, `from`);
  - typing in a field, ticking a box or moving focus is filling a form in, not
    an action: such events that stay in the browser are left out (a login page
    of two buttons no longer lists its phone and OTP inputs); a field that calls
    the backend as it changes stays;
  - clicking a row no longer scrolls the list.

  The sidebar has two parts: "In the app's menu" — the pages the app's own
  menu shows, in its order, with what they lead to — and "Other pages" —
  sign-in pages, what is on every page, the menu's own buttons, and screens
  nothing links to. An app without such a menu keeps the by-page list. New `appNavigation()` and
  `appSidebar()` in `@flowslens/core`, and `/api/navigation` in `serve`.

### Changed

- **The sidebar opens folded.** Every page, menu entry and shared group starts
  closed, so the list reads as an outline of the app; "Expand all" opens them.
  Reloading keeps the selection in the address (`#flow=…`, `#entry=…`) but
  unfolds nothing; selecting an action from another tab still opens the group
  it is in.
- **A component on three or more pages is listed once.** The sidebar gave a
  walk-in form that 27 pages can open 27 copies, and burying each page's own
  buttons under the same shared rows. It now has its own group ("Walk in form ·
  shared · on 27 pages"), and every page that renders it links to it under
  "Also on this page".
- **What the user can do comes first.** Within a page, buttons and forms are
  listed first and "When the page opens" is folded underneath, opening by
  itself when you search or select one of its actions.
- **Pages are named the way the browser tab names them.** `<title>Bills ||
MyClinic</title>` (or App Router `metadata.title`) makes `/billing` "Bills",
  with the route underneath; the sidebar search matches the title too.
- **Clearer titles.** A page component called `Index` no longer gives "Medication
  · Index loads" ("Medication loads"), and two components with one name are
  told apart by their file name ("Time slot popup new") rather than the full
  path.

### Fixed

- **A second audit against MediStock, fixed.** Every item below was checked
  against the app's code.
  - **Popups.**
    - A dialog's form runs through the form's own validation (the per-page copy
      of its submit is the action shown, under the name the page gives it:
      "Save medicine", "Update medicine").
    - Its fields are named by their labels, not their placeholders, and a long
      form is counted ("and 14 more").
    - A popup's own controls are not mixed with a dropdown widget's internals.
    - A file input is "Choose a file", and picking a file is a step before
      "Continue".
    - A dialog's own load is not taken as the thing the user presses.
    - "Save update" in a dialog is its own action, not a relay of the dialog's
      close, and the Close row is described through Cancel, not Save's
      `onSuccess`.
    - Docs names the page and the opener of the copy it describes.
  - **What happens after an answer.**
    - The `useEffect` that reacts to a query's answer is drawn ("Import
      complete" / "Import failed"), and so is code that runs as the component
      draws with it (auto-select the only clinic, "Medicine not found", the
      loading placeholder).
    - A job's background worker is drawn after the response, with its
      `on("failed")` handler.
    - `.catch(() => {})` reads "the error is ignored", and Docs says the steps
      after it run either way.
    - `invalidateQueries()` with no key says the data on screen loads again.
  - **What the server answers.**
    - A route's own `catch` answer (503 "Could not queue the import") is in
      Docs.
    - A message passed through a result (`apiError(result.error)`) is read from
      the function that returns it ("Medicine not found").
    - A success body leaves out the shape the route already answered with an
      error.
    - A query run only under a condition in its caller says so ("when
      `updated.currentStock !== previousStock`"), not "always".
    - An update with `{ upsert: true }` reads "upsert".
    - A server-side `fetch(config.url)` is an outside call, shown in Docs.
  - **Decisions.**
    - The search debounce ("once the typing has stopped for 350 ms") is drawn.
    - So are a `??` default on an input or a query's answer, an input compared
      with a fixed value, an aggregation's `{ ownerId }` match, and
      `ensureIndexes`.
  - **The sidebar.**
    - The mobile and desktop copies of a row's button are one feature.
    - A page's tabs are parts of their own, named by the tab button, each with
      its own pager. Their features are counted.
    - Breadcrumb links handed to a component as data are listed.
    - A link whose words are row data is named by its fields (`‹name›`).
    - A section title chosen by a prop uses the prop this page passes ("Batch /
      purchase lot (active batch)").
    - Two buttons with one name in one component are told apart by the screen
      each is on ("Sign out — on "No clinic access"").
    - A widget's own controls used on most pages are not listed under the
      layout.
    - A menu link shows the pages it goes to.
  - **Docs.**
    - A field filled on an earlier step is marked "entered earlier", not
      counted again.
    - A preprocess that fills in a blank makes the field optional.
    - An enum's values are read from the constant list it names, with its
      message.
    - Every field the schema takes is listed, `remarks` included.
    - "Disabled while `!canSave`" no longer claims to stop a double send; the
      button's `loading` does.
    - A component drawn in two places lists both, and a page load names its
      page.
    - Titles that share a name are told apart by the fewest words that do it.
  - **Timing.**
    - "Observed duration" is the outermost span, not a sum of steps that ran
      at the same time.
    - A click counts as traced only if its own click was recorded, not because
      a request it shares was timed from another button. "Confirmed by runtime
      tracing" follows the same rule.
    - Two of the same query under one request are matched to their own lines,
      in the order they started.
    - A function whose query was seen running is not "never observed".
  - **Findings.** Independent reads with plain work between them are flagged.
  - **Cards.**
    - A card says what it asks for
      (`{ expiring: true, sortBy: "expiryDate", pageSize: 5 }`).
    - A value handed to a component is shown through it (`<ExpiryBadge>`).
    - A pipeline total is followed back through the field it sums
      (`$cost` → `batchSumExpr`).

- **Popups written as their own component are features too.** Some buttons
  open a dialog that lives in another file: `<AddMedicineDialog
open={addOpen} />`, `<ImportDialog>`, `<AdjustStockDialog>`. Each is now one
  row whose flow runs from the click through the dialog's save request.
  Before, these rows read "stays in the browser". A wizard's earlier step
  ("Continue" to a preview) is drawn before its main one ("Import rows"). The
  dialog's own load is no longer taken as the thing the user presses.
- **A button that calls `router.push` says where it goes.** Examples: View →
  Medicines › Details, Edit → Medicines › Edit, Back → Medicines. The route
  keeps every segment of a template string:
  `/medicines/${id}/edit` is `/medicines/[param]/edit`, not `/medicines/…`.
- **An empty state with a title is a part of the screen.** The second "Add
  medicine" and the "Clear filters" that only show when nothing is found are
  listed under "No medicines found".
- **Smaller fixes:**
  - Each query in a `Promise.all` is named after its own result in Docs.
  - A `new Map()` called `cache` is no longer listed as leaving the app.

- **The Decisions tab now matches a hand-traced chart of a NestJS + axios
  download, end to end.** Checked against a hand trace of Billing → Download
  Report:
  - Passport's own check comes before the strategy's `validate`: a Bearer token
    signed with the secret (and whether its expiry is checked), and a 401 when
    it is missing or forged, or when `validate` gives back nothing.
  - An aggregation is drawn per record: each `$lookup` names the collection it
    reads, `$unwind` without `preserveNullAndEmptyArrays` leaves out a record
    with no match, and each `$match` (including `$size: 0`) is a decision.
  - The API client's request interceptor, and its success and error answers,
    are drawn as a branch. An error interceptor that sends a 401 to the login
    page and returns nothing resolves the request with `undefined`, so the next
    `response.data` throws and the screen's `catch` runs. Before, the success
    steps were drawn as if they still ran.
  - The request wrapper's send step says which Authorization header this caller
    gets, its timeout and its `responseType`. A `catch` that reads
    `error.response.data.message` after asking for a Blob is flagged: that
    message is never read.
  - The browser's file save (`createObjectURL`, `click`, `revokeObjectURL`),
    `app.useGlobalPipes(…)` and the DTO a `ValidationPipe` checks are drawn.
  - A helper called inside an `if` condition, or inside the value being set,
    is no longer drawn a second time.
- **Docs lists every collection a request reads.** That includes collections
  joined by `$lookup`, and the reads the middleware does to find the user
  (through `new Guard().canActivate()` and Passport's `validate`). Two
  `findById`s in one Nest method are now two queries.
- **Decision trees build much faster on large apps.** A condition's variable
  is looked up in the syntax tree rather than through the type checker. A
  file's functions, calls and local variables are each indexed once instead of
  scanned on every lookup. On a 1,800-action app, Download Report's tree went
  from 6.8 s to 0.6 s, and every tree together builds in about 6 minutes in
  steady memory (2.9 GB). Before, the server ran out of memory.

- **Every tab says what the code really does, in the order it does it.** An
  audit of a real Next.js + Mongo app against its source found, and this fixes:
  - steps were sorted by depth, then alphabetically: the service came before
    the access check the handler runs first, and a toast in `onSuccess` before
    the request it reports on. Steps now follow the code, depth first, each
    function's calls in the order written; what `onSuccess`/`.then` runs comes
    after the response, and a check halfway down a handler is no longer said to
    run "before any work";
  - every page load read "Success: nothing visible · Error: not handled". What
    the screen shows is read from the component — the skeleton while loading,
    the empty state, the error state, a redirect — through context too (a
    provider's `loading`/`error`/`status` followed to the gate or layout that
    acts on it);
  - runtime tracing turned a click on a menu link into an action
    "GET /settings — no auth check"; pages the browser opens are not requests;
  - wrapper buttons (`<button onClick={onClick}>` in `IconBtn`), a dialog's
    backdrop and a form's own Save that only hands its values up were listed
    beside the real actions; a control shared by several pages (Prev/Next,
    Sort) was placed on pages that never give it what it needs, and a
    component name two files define privately carried one page's controls onto
    another. A shared control is now one action per page, each with its own
    request;
  - missing work: writes in a module's private helper (`recordMovement`), the
    second of two identical queries in one function, the background worker a
    queued job runs (BullMQ/Bull, after the response), the refetch a filter,
    sort, page or tab change sets off, and `useMutation`/`useQuery` written in
    the component;
  - a query switched off by `enabled` was counted as loading with the page; a
    list shown only on a tab is "when shown", not "on load";
  - invalidations were matched to endpoints by a word in the URL; they now
    match by query key, as React Query does;
  - names nobody can read — "as", "button onClick", "View close (line 373)",
    "Import row s (${n} ignored)" — are now the words on screen, the field a
    control is bound to, the heading above a list, "Close …", "Open …";
  - an action is only timed when its own request was traced, not by a step it
    shares with another action;
  - the sidebar count, the page header and the page summary count the same
    things; `#tab=…&flow=…` links work without a reload, and Back/Forward too.

- **A feature behind a popup is one row, with its whole flow in every tab.**
  "Download Report" opens a popup where the user picks two dates and presses
  "Download". The button that opens a popup is joined to the popup's main
  action (the one that sends a request: a submit, or a "Download"/"Save"-like
  button), so its tabs run from the first click, through "in the popup, the
  user fills Start date, End date and presses Download", to the request, the
  middleware, controller, service and collections. In the sidebar it is a
  single row, not a fold of the popup's buttons. An `@Res()` handler's
  `res.status(400).json(…)` is now in the Docs tab's responses too, and a
  controller's decorators are no longer listed as calls.

- **A page's children are its features, as a user would list them.** Billing
  read as 26 rows; it is now Download Report, Add New Bill, Paid / Outstanding,
  the search, the date filter, each bill's actions and the pager:
  - a popup is the feature of the button that opens it — found from what the
    button sets (`setOpenDownloadReportPopup(true)`, `open={addOpen}`), named
    after it when it has no title, with its dates, Download and Close inside;
  - the buttons repeated on every row of a list are one part, "Each bill" (the
    desktop table and the phone cards once); a pager is one part;
  - a shared widget's own mechanics (a dropdown opening its list), a
    component's inner control the page already names (the tab button inside
    `<Tabs onChange>`), and empty popups are not listed;
  - a search box, a date filter, tabs and page buttons that reload a list
    through `useEffect(…, [search, date, page])` show the request they cause,
    instead of being hidden as "stays in the browser";
  - setters are paired with their state by position in `useState`, so
    `[openBillingPopup, setOpenBIllingPopup]` is recognised;
  - the sidebar count, the page header and the summary count a page's features
    the same way: its controls, links and each part once — not what is inside a
    part, not the pages it leads to, not what loads by itself.

- **The Decisions chart follows a request the whole way, as a hand-traced one
  does.** Checked against a hand-drawn chart of a Next.js + NestJS "Download
  report":
  - an endpoint called from several screens drew another screen's code; each
    action now draws its own call;
  - the app's request wrapper (`getRequest()` picking the token) and its
    client's interceptor (a 401 sent to the login page) are opened;
  - NestJS middleware applied in `configure(consumer)` — `apply`, `exclude`,
    `forRoutes` with paths, methods and controllers — runs in front of the
    routes it covers, opened, with the Passport strategy behind
    `AuthGuard('jwt')`;
  - an `@Res()` handler's `res.status(400).json(…)` and `res.send(…)` are its
    answers (the catch no longer reads "the error is ignored"), headers it sets
    are steps, and a default filled in from an input (`from ? … : a week ago`)
    is a decision;
  - a prop the page passes (`onSubmit={updateMedicine}`) is followed into the
    page's function; a load runs every function it calls as it opens; a
    `setTimeout` callback is drawn as "after 250 ms";
  - a capitalised handler (`const Discard = () => …`) and a callback handed to a
    child (`onSave={() => save()}`) are no longer counted as running when the
    page opens; closing a part (`setOpen(false)`) no longer loads it;
  - a request set off by a state change is labelled as such, and a `catch` that
    only logs says so. A crash on `obj.hasOwnProperty(…)` in a condition is
    fixed.

- **Nothing in Flowslens knows any one app's words.** What it used to match by
  name is now read from the scanned project:
  - the tenant field is the id field its queries filter by across the most
    collections (`ownerId`, `orgId`, `garageId` alike), not one of a list of
    names;
  - an auth or membership check is any of the project's helpers that answers
    401 or 403 (`requireTeam`, `requireGarage`, …), as well as the generic
    names (`requireAuth`, `verifyToken`); a decision tree's "checks first"
    reads the same way;
  - a glued collection name (`teamsettings`) is split with the words the
    project writes in its own identifiers (`getTeam`, `getSettings`), and
    acronyms are the ones it writes in capitals (`sendOTP`) — the built-in word
    list of business nouns is gone.
- **Each query in a decision tree says what it does.** A dashboard handler's
  six reads of two collections drew as "Read medicines" three times and "Read
  movements" three times. Each now says where its result goes and what it asks
  for, read off the call:
  - `→ recentlyAdded · where ownerId · newest createdAt first · up to 5`
  - `→ todaysUpdates · counts where ownerId, createdAt (range)`
  - `→ rollup · pipeline $match → $project → $facet (totals, categories)`
  - a count is `Count movements` and a pipeline `Aggregate medicines`; "Copy as
    text" carries the same line.
- **A recorded query is placed where the request really runs it.** A span
  names only `movements.countDocuments`, and an app runs that in several
  functions; the merge took the first one in the graph, so the dashboard's own
  count was shown on the stock-history list's line, and a page seemed to run
  queries it never ran. The request a query ran under now decides: the query
  site its handler reaches in the code. With several sites and none reached,
  it stays a query seen at runtime rather than a guess at another function's.
- **A request helper importing `next/server` is server code.** `NextRequest`
  made `lib/api/server.ts` read as browser code, so an access check every route
  runs (`requireClinic` → `hasClinicAccess` → its queries) was invisible to the
  static read, and showed up only on the routes a trace happened to record.
  `next/server`, `next/headers` and `next/cache` now mark a module as server.
- **Decision trees left out parts of the feature.** An audit of every tree of a
  real app against its source found, and these now draw:
  - a helper whose decisions only set values — a query filter built field by
    field (`if (query.category) filter.category = …`), a match pushed in a loop
    (`if (contact) matched.push(…)`) — and a `switch` that only picks which
    value to return; before, such helpers showed as one line, hiding the
    branches that define the feature;
  - a throw nothing catches on the way out of a route, which now ends in the
    500 the framework answers instead of a bare "throws";
  - a helper called with different arguments, each call on its own:
    `requireEnv("MONGODB_URI")` and `requireEnv("CLINICS_DB")` are two checks,
    and "opened above" no longer points at a call that was never drawn;
  - a button's `disabled={…}`, as the first decision of its click;
  - `refetchInterval` polling, as a loop around the request; and the requests a
    page starts as it opens, as starting together;
  - helpers ten calls deep instead of seven, so checks deep in a sign-in path
    are followed.
- **A page the browser opened was reported as a broken API call.** A Next.js
  `<Link>` fetches the page from its own address, so runtime tracing recorded
  `GET /stock`; it is now drawn as the page opening, with the loads that page
  runs, and is left out of the broken calls.

- **`onSubmit={handleSubmit(save)}` reached nothing.** React Hook Form's
  wrapper (and `form.handleSubmit`) is now followed to the function it calls,
  so those forms — often the main button on a screen — appear as actions with
  their requests.
- **A form was named after the wrong button.** The label now comes from the
  `type="submit"` element, whatever component it is (`<PrimaryButton
type="submit">`), including one outside the form linked by `form="id"`; a
  `type="button"` is never used. Text from a `? :` branch or a template string
  counts, and busy text ("Adding...", "Cancelling...") is skipped in favour of
  the real label or the handler's name.
- **Actions missing from their page.** A component rendered only by another
  component in its own file (a table cell), and a default import renamed at the
  import (`import LibraryPreview from "./MaterialLibraryPreview"`), are now
  followed up to the page.

## [1.3.1] - 2026-10-05

### Fixed

- **`@flowslens/cli` 1.3.0 failed on every command.** The release bumped all
  three versions but left the CLI pinned to `@flowslens/core` 1.2.0, so an
  install pulled the previous core and the first import stopped with "does not
  provide an export named 'actionDecisions'". The pin is 1.3.1, the lockfile
  links the workspace core again instead of a published copy, and the CLI's
  `prepack` now refuses to pack when the pin and the core version differ —
  `npm publish` stops before anything is uploaded. `tests/release.test.ts`
  checks the same in `npm run verify`.

## [1.3.0] - 2026-10-05

### Added

- **What your change breaks, line by line.** The Changed view now compares
  each changed file with its committed text declaration by declaration —
  functions, components, hooks, methods, object-literal methods, types — and
  says how each changed: deleted, renamed, no longer exported, signature
  changed (parameters matched by name, so an inserted parameter is one
  change), shape changed, or body only. Every use is found with the
  TypeScript language service, and the project is type-checked as it is and
  with the changed files put back, so only errors the edit introduced are
  reported — each with its code, the compiler's message, a plain-words version
  ("Missing `currency` — `formatCurrency` now needs it as argument 2.") and
  the feature, page, component, API and service it sits in. Plain JavaScript
  callers are judged against the new parameter list. Runs locally, no service.
  Also `GET /api/changed/breakage` and `analyzeBreakage()` in
  `@flowslens/core`.
- **The action list is grouped by page.** The dashboard sidebar puts each
  action under the page the user meets it on — `/medicines`, `/settings` —
  not the folder its code lives in. A dialog or form is followed up through
  whoever renders it (`<AddMedicineDialog>` on the medicines page), so it
  lands on that page; a component rendered from two pages is listed on both;
  one only a layout reaches goes under "Every page"; and actions nothing
  renders go under "Other actions". Each page is named in words ("Medicines ›
  Details") over its route; each row says what the action is without
  repeating the page ("Delete", "Submit — in Add medicine dialog"), has an
  icon for whether it runs on open, on a click or on a submit, and shows the
  API it calls as a coloured method and path. Within a page, what runs when
  it opens is listed apart from what the user can do. Groups fold one at a
  time or all at once, the search matches page routes and says when nothing
  matches, `/` jumps to it and the arrow keys walk the list. `/api/flows` now
  gives each action its `pages`, and `flowPages()` is in `@flowslens/core`.

### Changed

- **The npm pages describe what the packages do today, and link back to the
  repository.** The repository is public again, so `repository`, `homepage`
  and `bugs` point at GitHub (with the email kept for bug reports), and each
  README links to the source, issues and changelog. The `@flowslens/cli` page
  documents the six tabs, the page-grouped action list, Decisions and the
  type-checked breakage check; `@flowslens/core` documents `actionDecisions`,
  `analyzeBreakage` and `flowPages`. Descriptions and keywords now name what
  developers search for — flowchart, breaking changes, dead code, MCP, Nuxt,
  Fastify, the MongoDB driver. Prisma, read since 1.1.0, was still listed as
  "not yet" in two tables; it is listed as read.

- **Issues and Impact are one tab: Issues & impact.** Both asked "is this
  safe?" — Issues about what is already wrong, Impact about what a change
  would break — and a reader checking an action before an edit had to read
  both. The tab opens with three cards, one per question (your uncommitted
  changes, the bugs in this action, what a change to it would reach), each
  giving its answer and opening its section. The sections follow, the most
  urgent first, and each folds with its answer still on its heading; your
  changes start folded when nothing breaks, since the card already says so.
  The rest of the project's issues come last, and their filters redraw only
  that list. The badge is the most worrying answer: "2 breaking", then
  "3 issues", then "12 at risk". `#tab=issues` links open the merged tab.

- **Changed and Breaks are one tab: Impact.** Both answered "what does my
  change break?" — Changed after the edit, Breaks before it — and a reader had
  to know which was which. Impact shows your uncommitted changes first (the
  breaks grouped by page and component, each reason said once with every
  line under it, then one card per changed declaration) and then what a
  change to the selected action would reach. The file-level list of actions
  is folded under the first part, since it over-counts on purpose. The tab
  badge reads "11 breaking" when your edits break something. `#tab=changed`
  and `#tab=breaks` links open Impact.

- **A Decisions tab — every way an action can go.** The action as a
  flowchart — pills, step boxes, decision diamonds and database drums joined
  by labelled yes/no arrows, each step in plain words with its code on
  request — from the click to the database and back: each `if`, `switch`, `?:`,
  `&&`, `try`/`catch` and early `return`/`throw` is a decision with what runs
  on each answer — the frontend check that stops a submit, the request and the
  server function that answers it, the status each guard responds with, the
  branch that picks `updateOne` over `insertOne`, and the `onSuccess`/`onError`
  the screen ends in. Read from the source of the functions the action runs,
  following the project's own helpers and `this.service.method()` into the
  injected class; library calls are left out. Also `GET /api/decisions`
  (`format=text` for the tree as plain text) and `actionDecisions()` /
  `renderDecisionTree()` in `@flowslens/core`.

### Fixed

- **Decisions say what a check means, not how it is spelled.** A condition is
  read through the variable it tests: `if (!parsed.success)` after
  `schema.safeParse({ phone, otp })` is "Are phone and otp valid?" (and "Is the
  request body valid?" on the server), `if (!ok)` after `await verifyOtp(…)` is
  "Did verify otp succeed?", `res.ok` after a `fetch` is "Did the request
  succeed?", a confirm dialog is "Did the user confirm?". Lengths, numeric
  comparisons, `!!x` and `x?.trim()` get plain wording too; compound
  conditions still show their code rather than a guess.

- **Queries on `db.collection<Doc>("x")` are found, and an array's `find` is
  no longer one.** A collection opened with a type argument, or across lines,
  was named after the variable (`dbs.find`) or missed; `clinics.find((c) => …)`
  on a plain array that shares a collection's name was reported as a read.
  Every tab that lists queries was affected.

- **The Decisions tab follows the code the way it runs.** Checked flow by flow
  against a real app: work inside a response (`json(await listX())`), inside
  `Promise.all` (drawn as parallel), `.map` callbacks, IIFEs and callbacks
  passed to helpers is followed; `continue`, `break`, switch fall-through and
  a catch that swallows the error are drawn as the decisions they are; the
  filter conditions a query is built from and `?:` chains that pick a value
  are shown; a forwarded `ctx.error` carries every status it can have, a
  NestJS handler its default 201/200, and the API client's response
  interceptor sits between the answer and the screen.

## [1.2.0] - 2026-09-30

### Added

- **`flowlens unused` and an Unused tab — code nothing uses.** Files and
  folders no entry point reaches (a dead helper only another dead helper
  imports included), exports nothing imports — told apart from exports only
  used in their own file — dependencies nothing imports, relative imports that
  point at no file, and backend routes no frontend calls. Entry points are what
  the app starts from: framework route files, what `package.json`, its
  scripts, a Dockerfile or a README command runs, `scripts/`, config files and
  tests. Read at scan time from the imports FlowLens already resolves, type
  imports included; also the `find_unused` MCP tool. On the example app it
  found that `main.ts` imported an `app.module` that did not exist, which made
  the whole backend unreachable — the example now has one.

- **`flowlens mcp` — ask your AI assistant, answered from the graph.** A Model
  Context Protocol server on stdio with nine read-only tools: list and explain
  actions, which actions run through a file or line, what a change to a symbol
  breaks, issues, what the uncommitted changes reach, the tests to write, and
  per-step and per-query timings. Nothing listens on a port and nothing leaves
  the machine; the protocol is written by hand, so the CLI still depends only
  on its own core. `claude mcp add flowlens -- npx -y @flowslens/cli mcp .`
- **`flowlens diff --base main` — what a branch changes about the app.** Scans
  the branch (uncommitted work included) and its fork point in a temporary git
  worktree, and reports the actions it reaches and which have no test, issues
  it introduces or fixes, collections that gained a writer, and endpoints
  added or removed — as a pull request comment, or `--json`. `--fail-on high`
  fails CI on a new high-severity issue. `docs/ci/flowlens-pr.yml` is a ready
  GitHub Actions workflow that keeps one comment per PR up to date, with the
  built-in token only.
- **Next.js and the native MongoDB driver, traced by the package.**
  `export { register } from '@flowslens/runtime/next'` in `instrumentation.ts`
  traces App Router requests; `traceDb(client.db())` traces the raw driver.
  Proven under Next 16 with Turbopack: the click, the request and the query
  land in one trace. `flowlens instrument` writes those files for you — new
  files only, printing the lines that belong in files you own — and knows
  Express, Nest, Fastify, Mongoose and the package manager in use.

- **Issues: bugs the code shows, each with the line to open.** A new tab and a
  `flowlens findings` command run six checks over the whole project — routes
  with no auth check, queries that forget the tenant, the tenant id taken from
  the request, the request body written as is (mass assignment), queries run
  once per item of a loop (N+1), and independent reads awaited one after
  another. The tenant field is learned from the filters that use it. Each
  finding says why it matters, how to fix it, and what would make it a false
  alarm; nothing it cannot read is guessed at, and a by-id query is only rated
  high when its id is traced to the request. `--json` and `--fail-on high` make
  it a CI gate.
- **Queries with their code and their time.** Every database query an action
  runs, as the backend wrote it — the whole chain, and the lines that build a
  filter held in a variable, one helper deep — with its average, fastest and
  slowest time from runtime spans. Nothing connects to a database.
- **Every `file:line` opens the editor**, including inside diagram cards and in
  prose, and looks like a link (`?editor=` picks VS Code, Cursor, IntelliJ, Zed…).
- **Confirmation dialogs** (`confirm()`, SweetAlert, a `confirmDelete` helper)
  are their own step in the action document and the diagram, instead of being
  reported as frontend validation.
- **Tests: the tests to write first.** On an action nothing tests, the tab
  now lists the cases worth writing, read off the action's own document —
  every response the route can send and why (401, 403, 422…), every write,
  and what the user sees when it fails — ordered access, rejections, data,
  success, screen, with an `it.todo` skeleton to copy and where to put it.
  Where tests exist, the same list is a folded checklist to hold them against.

### Changed

- **Docs: "At a glance" is the document.** Each stage is a line that opens in
  place to its detail, all closed at first, instead of the whole document
  repeated below the overview.
- **Changed follows imports.** A changed file that declares no step of its own
  — the database connection, a shared client — reaches every action whose
  files import it, directly or further down, `@/` aliases included. It used to
  be reported as reaching nothing.
- **Two actions with the same title are told apart** by their component, then
  page, file or line: "Medicines · Delete (Medicines view)" and "(Medicine
  detail page)".
- **Performance says how many runs a ranking rests on**, and warns when the
  slowest step was measured fewer than three times.

- **Six tabs, none repeating another:** Docs, Issues, Performance, Tests,
  Changed, Breaks. The Flow diagram is now Docs' _Diagram_ view; what only the
  APIs tab showed (the contract check, a curl command, who else calls the
  endpoint, statuses seen) moved into Docs' request and response steps; Timing
  and Queries became Performance. Old `#tab=flow|apis|timing|queries` links
  still land in the right place.
- **The action document shows only the steps an action has**, numbered without
  gaps, and lists the rest under "Not in this action" with the reason — so "no
  auth check" is still stated.
- **The diagram reads as a story:** numbered cards that say what each step does,
  hooks that only hand the handler a helper folded onto its card, and the way
  back to the screen as its own lane.
- **Findings are fast on large backends:** line numbers come from a per-file
  index instead of rescanning the source (193s → 4s on a 925-query backend).
- **The launcher sends first-run build output to stderr**, so `--json` output
  stays machine-readable.

- **A seventh dashboard tab: Docs.** The other six answer a developer's
  question about one action. This one describes the whole screen that action
  sits on — what the page is for, what it does when it opens, what every
  button does end to end, what it stores and what to be careful with — in
  sentences with no jargon in them. It is the answer to "can you write up what
  this page does" that used to mean an afternoon and a wiki page that went
  stale the same week.

  The document is deliberately complete rather than short, because the
  question is really four questions:

  - **Everything on this screen, at a glance** — one row per control, with the
    requests it makes and the tables it reads, adds to, changes or deletes
    beside it. Reading eight paragraphs to learn that only one button writes
    anything was the failure this table exists to prevent.
  - **Each action, start to finish** — what the user supplies, the steps in
    order, and a table of exactly which collection each step reads or writes,
    down to the call (`find` versus `findOne` is the difference between a list
    and a detail page, and the name is the only place it is written down).
  - **The information this screen works with** — every collection, its schema,
    the fields that schema declares, and which actions on the screen use it.
  - **How the information fits together** — see below.

  **No model is involved.** Every sentence is a template over a fact already in
  the graph (`core/flow/explain.ts`), so it says only what the code says, reads
  the same on every run, and cannot invent a step that is not there. Where a
  fact is missing it is left out and said so under "What this document does not
  cover", because a confident sentence nobody can check is worse than a gap.

  A screen picker switches pages without disturbing the feature list, and
  **Copy as Markdown** hands over the same document — one renderer, so the page
  and the paste cannot drift apart. New endpoints: `GET /api/screens` and
  `GET /api/screen?name=…` (`&format=markdown`).

- **Flowslens now reads how the collections link to each other**
  (`core/analyzer/relations.ts`), which is the one relationship a document
  database never writes down where it matters. A screen showing orders is
  showing customers too, and no amount of reading the `orders` schema reveals
  it. Four sources, kept apart rather than flattened:

  - a declared Mongoose `ref`, including `[{ ref }]` for a list;
  - a Prisma `@relation(fields: […])`, read from `schema.prisma`;
  - an aggregation `$lookup`, a `.populate()` or a Prisma `include` — a query
    _following_ the link, which is stronger evidence than a declaration;
  - the naming convention, when a field called `customerId` sits next to a
    `customers` collection — including one level down, so the `productId`
    inside `products: Array<{ productId }>` is found, which is how every
    order, invoice and cart is modelled.

  The last of those is an inference and is labelled as one everywhere it
  appears, in the table cell and again by name under "What this document does
  not cover". It is only reported when the collection on the other end is one
  the scan actually found: a `subjectId` in a project with no `subjects`
  produces nothing at all rather than a plausible-looking wrong answer.

  What it buys, beyond the prose: the Docs tab now warns when **a screen
  deletes records that other collections point at** and nothing on the screen
  tidies them up. That is invisible from the screen, from the code it runs and
  from every other tab — the orders naming a deleted customer are not on the
  page, which is exactly why nobody notices until they are.

### Fixed

- **The trace context is one per process, not one per bundle.** Turbopack
  compiles `instrumentation.ts` and the route handlers into separate module
  graphs, so a module-scoped AsyncLocalStorage gave the request and database
  tracers different stores and no query nested under its request. It is now
  kept on `globalThis` under a registered symbol.
- **"No handler catches a failure" on code that did.** Only `try/catch` counted
  as handling an error, so `mutate(id, { onError })` — how React Query code is
  written — and `.catch()` were reported as unhandled rejections on every save
  in a real app. Setters and toasts inside them are now the failure path.
- **A request with a real id became its own endpoint.** A browser span for
  `/medicines/med_2bbed44f4aa4` only matched an api-call with that exact path,
  so every record clicked minted a step, and the declared `/medicines/:param`
  was listed as never having run. Runtime calls now match the declared
  templates first, then the route's.
- **Clicks the source does not name became actions.** A confirm dialog's "Yes,
  delete it", a nav link, a table row titled with a medicine's name — each was
  listed as an action repeating requests a real one makes. They are dropped
  when every request they made is already declared; one that reaches an
  endpoint nothing declares is still listed.

- **A collection a trace discovered was reported as written to.** A db-op that
  only runtime had seen carried no effect, so every reader fell back to
  "write": a `find` the static analyzer never reached was described as changing
  the collection it had only read. The merge now classifies runtime operations
  the same way the source reader does.
- **`flowlens serve` in a checkout served a stale dashboard.** `prepack` stages
  `apps/dashboard/public` into `packages/cli/dashboard`, which is gitignored
  build output that nothing deletes; the lookup found it first, so edits to the
  dashboard appeared to do nothing until the next `npm run clean`. The working
  copy now wins, which can only ever differ during development — a published
  package has no `apps/` beside it.

## [1.1.2] - 2026-09-15

### Changed

- **The published packages no longer depend on the repository being reachable.**
  The source repository is going private, so `repository`, `homepage` and `bugs`
  pointing at GitHub would have become three dead links on every npm page — the
  first thing a reader clicks. All three packages now carry an npm homepage and
  an email for bug reports instead, and the six GitHub links inside the
  published READMEs point at the sibling packages or are gone.
- **`@flowslens/cli`'s npm page is now the landing page.** With the repository
  private, the long root README stops being public, so the content that explains
  what the tool actually does had to move to the page people can still reach:
  the six dashboard tabs and what each answers, why **Breaks** is the one that
  changes how you work, and the table of request shapes — awaited chains,
  `.then`, `Promise.all`, a `useEffect` waiting on state, `if`/`else`
  alternatives, and error paths.

### Note

Making the repository private stops browsing and cloning. It does not make the
code unreadable: an npm package is JavaScript, and every version published so
far is MIT-licensed and permanently available. This release is about not
shipping broken links, not about secrecy.

## [1.1.1] - 2026-09-15

### Changed

- **Package metadata written for the people looking for this.** The three npm
  descriptions described the packages to someone who already knew what they
  were — `@flowslens/cli` said "Flowslens command line interface", which is
  true and unsearchable. They now say what the tool does, in the words somebody
  with this problem would type. Keywords went from 6–10 per package to 18–24,
  covering the frameworks read (React, Next, NestJS, Express, Prisma, Mongoose,
  MongoDB) and the jobs people search for — impact analysis, blast radius, data
  lineage, dependency graph, codebase onboarding, legacy code, refactoring.
  Metadata only reaches npm on a publish, which is the reason this release
  exists.
- **A packages table in the README**, with version and monthly-download badges
  for all three. GitHub's own "Packages" sidebar only ever lists GitHub Packages
  registry artifacts, so npm packages cannot appear there — and the scope would
  have to match the repository owner to publish them there at all. The README is
  the page people actually land on, so that is where the published state
  belongs.
- The GitHub repository description now mentions Prisma, which 1.1.0 added and
  the old text still omitted, and leads with the question the tool answers.
  Topics went from 10 to 20, GitHub's maximum. The homepage points at the npm
  package rather than back at the README it is written in.

### Fixed

- The README badge and the test-suite counts said 480 tests across 22 files.
  The suite is 482 across 21; the file count had been wrong for several
  documentation passes, and the two `.gitignore` tests added last were never
  counted.

## [1.1.0] - 2026-09-15

### Added

- **Two more tabs, and the Breaks tab now separates findings from wallpaper.**
  Measured against a real 132-flow project, the first version had two problems
  worth fixing before adding anything: `useToast` was the single most-flagged
  "shared step" in the whole graph (13 features, because they all show a toast),
  and "Products · Delete" appeared twice in the same list with no way to tell
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
    `useToast` to `GET /products`.
  - **Colliding feature titles get a distinguishing suffix** (`Products ·
Delete · ProductsView`), and only when they collide.
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

  await Promise.all([api.get('/products'), api.get('/shops')]); // both at once
  ```

  Requests are now numbered in source order and each one says when it happens:
  `needs the response from GET /carts/current`, `only after POST
/coupons/validate resolves`, `sent at the same time as GET /shops`.

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
    `invalidateQueries({ queryKey: queryKeys.products.all })` fires fresh
    requests from components you are not looking at. Reading it needed two
    fixes beyond the obvious one — after-effects are collected from **hooks**
    as well as handlers, because `useMutation({ onSuccess })` inside a custom
    hook is where a React Query app actually keeps its invalidation; and key
    **factories** are read as written (`queryKeys.products.all`) rather than
    only literals, since a real project has no literal keys. On the production
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
  - **`flowlens.config.json` is ignored too**, because Flowslens wrote it. On a
    default setup it is the only file the tool puts in a project, so leaving it
    out left `?? flowlens.config.json` in `git status` on every branch forever —
    the exact chore this feature exists to remove. `init` adds it in the same
    breath as writing it, rather than a scan later noticing.
  - **A config the developer committed is left alone.** A pattern for a tracked
    file changes nothing, so adding one would read as a fix while doing nothing
    — and a team that committed the config on purpose keeps it. The point is to
    stop the tool leaving mess behind, not to overrule a decision someone made.
  - **Nothing is added for a file that does not exist.** Only the config
    actually on disk is named, and only the alternate spellings (`.flowlensrc`,
    `.flowlensrc.json`) that a project really uses — three patterns in every
    repository, two of them matching nothing, is the block of speculative
    patterns this was always meant to avoid.
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
  1. PUT  /products/:param  first     1. PUT  /products/:param  only when isEdit — otherwise POST /products
  2. POST /products         second    1. POST /products         only when not isEdit — otherwise PUT /products/:param
  3. POST /errors           third     2. GET  /products         sent second
                                      3. POST /errors           only when the request fails
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

[unreleased]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Kishan-Jaiswar/flowlens/releases/tag/v0.1.0
