/**
 * The tests to write for one action, read off its document.
 *
 * The Tests tab used to answer only "which tests import these files", and on a
 * project with no tests that is a page of zeros — true, and no help deciding
 * what to write first. The document already knows every response the route
 * can send and why, every write the action makes, and what the screen does
 * when the request fails. Each of those is a test case someone would otherwise
 * have to derive by reading the code, so this lists them, most important first:
 * who may call it, what it rejects, what it changes, what it answers, and what
 * the user sees.
 *
 * It reads the document's own tables rather than the source again, so a case
 * here can never claim something the Docs tab does not show.
 */

import { dirname, extname, basename } from 'node:path';
import type { ActionDoc, DocGroup, DocLine, DocRow, StageKey } from './action.js';
import type { FeatureFlow } from './resolve.js';
import type { SourcePoint } from './actionsource.js';

export type TestCaseKind = 'access' | 'rejects' | 'data' | 'answers' | 'screen';

export interface PlannedTest {
  kind: TestCaseKind;
  /** The `it(...)` title, plain text. */
  title: string;
  /** Why it is worth a test, in one line. */
  why: string;
  at?: SourcePoint;
}

export interface TestPlan {
  /** Where the request tests would sit, next to the route they exercise. */
  file?: string;
  /** Where the screen tests would sit, next to the component. */
  screenFile?: string;
  cases: PlannedTest[];
  /** A `describe` block of `it.todo`s — valid in Vitest and Jest alike. */
  skeleton: string;
}

const ORDER: Record<TestCaseKind, number> = {
  access: 0,
  rejects: 1,
  data: 2,
  answers: 3,
  screen: 4,
};

const WHY: Record<TestCaseKind, string> = {
  access: 'Who may call it — the check a refactor removes without anyone noticing.',
  rejects: 'Bad input the route turns away; without a test, a change can let it through.',
  data: 'What the action changes in the database — the part a user cannot undo.',
  answers: 'The success answer the screen is built on.',
  screen: 'What the user sees when it goes wrong.',
};

export function planTests(doc: ActionDoc, flow: FeatureFlow): TestPlan {
  const endpoint = doc.endpoints.length === 1 ? doc.endpoints[0] : undefined;
  const subject = (text: string): string => (endpoint ? `${endpoint} ${text}` : text);
  const cases: PlannedTest[] = [];

  for (const row of tableRows(doc, 'response')) {
    const [status, when, message, from] = row.cells.map(plain);
    // `_the check itself throws_` — a condition no request can set up on purpose.
    if (!status || !when || row.cells[1]?.startsWith('_') || row.tone === 'muted') continue;
    if (row.tone === 'ok') {
      // With two endpoints the handler is the only thing saying which one answered.
      const origin = !endpoint && from ? ` (${from})` : '';
      cases.push({
        kind: 'answers',
        title: subject(
          `answers ${status}${message ? ` with ${message}` : ''} for a valid request${origin}`,
        ),
        why: WHY.answers,
        ...(row.at ? { at: row.at } : {}),
      });
      continue;
    }
    const kind: TestCaseKind = /^(401|403)\b/.test(status) ? 'access' : 'rejects';
    cases.push({
      kind,
      title: subject(
        `answers ${status}${message ? ` ${message}` : ''} when ${when}${from ? ` (${from})` : ''}`,
      ),
      why: WHY[kind],
      ...(row.at ? { at: row.at } : {}),
    });
  }

  for (const row of tableRows(doc, 'database')) {
    const [collection, operation, effect, calledIn] = row.cells.map(plain);
    if (!collection || !effect || /^read/.test(effect)) continue;
    cases.push({
      kind: 'data',
      title:
        `${WRITE_PHRASE[effect] ?? effect} ${collection}` +
        `${operation ? ` (${operation}${calledIn ? ` in ${calledIn}` : ''})` : ''}`,
      why: WHY.data,
      ...(row.at ? { at: row.at } : {}),
    });
  }

  for (const group of groupsOf(doc, 'final-ui')) {
    const prefix =
      group.label === 'After a failed response'
        ? 'when the request fails: '
        : group.label === 'If the frontend check fails'
          ? 'when the check in the browser fails: '
          : undefined;
    if (!prefix) continue;
    for (const line of group.lines) {
      const text = plain(line.text);
      /**
       * "Nothing handles the failure" is a gap, not a behaviour to pin. The
       * test worth writing is the one that fails today: the user should be
       * told, and a red test is how that gets fixed rather than forgotten.
       */
      const gap = /^Nothing handles/i.test(text);
      cases.push({
        kind: 'screen',
        title: gap
          ? `${prefix}tells the user it did not work (nothing does today — this test fails until it does)`
          : clip(prefix + text),
        why: gap ? 'A failed save that looks like a successful one.' : WHY.screen,
        ...(line.at ? { at: line.at } : {}),
      });
    }
  }

  const unique = [...new Map(cases.map((entry) => [entry.title, entry])).values()].sort(
    (a, b) => ORDER[a.kind] - ORDER[b.kind],
  );

  const routeFile = flow.steps.find((step) => step.kind === 'route')?.file;
  const screenFile = doc.source?.file ?? flow.source?.file;
  const file = routeFile ? testFileFor(routeFile) : undefined;
  const screenTest = screenFile ? testFileFor(screenFile) : undefined;

  return {
    ...(file ? { file } : {}),
    ...(screenTest ? { screenFile: screenTest } : {}),
    cases: unique,
    skeleton: skeletonOf(doc.title, endpoint, unique),
  };
}

const WRITE_PHRASE: Record<string, string> = {
  'deleted from': 'removes the record from',
  'inserted into': 'adds a record to',
  'updated in': 'changes the record in',
  'upserted into': 'creates or changes the record in',
};

/** `app/api/medicines/[id]/route.ts` -> `app/api/medicines/[id]/route.test.ts`. */
export function testFileFor(file: string): string {
  const ext = extname(file);
  const dir = dirname(file);
  const name = `${basename(file, ext)}.test${ext || '.ts'}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

function skeletonOf(title: string, endpoint: string | undefined, cases: PlannedTest[]): string {
  const quote = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = [`describe(${quote(title)}, () => {`];
  let kind: TestCaseKind | undefined;
  for (const entry of cases) {
    if (entry.kind !== kind) {
      if (kind) lines.push('');
      lines.push(`  // ${SECTION[entry.kind]}`);
      kind = entry.kind;
    }
    // The endpoint is in the describe once; repeating it in every title is noise.
    const text =
      endpoint && entry.title.startsWith(`${endpoint} `)
        ? entry.title.slice(endpoint.length + 1)
        : entry.title;
    lines.push(`  it.todo(${quote(text)});`);
  }
  lines.push('});');
  if (endpoint) lines.unshift(`// ${endpoint}`);
  return lines.join('\n');
}

const SECTION: Record<TestCaseKind, string> = {
  access: 'Who may call it',
  rejects: 'What it turns away',
  data: 'What it changes',
  answers: 'What it answers',
  screen: 'What the user sees',
};

function groupsOf(doc: ActionDoc, key: StageKey): DocGroup[] {
  return doc.stages.filter((stage) => stage.key === key).flatMap((stage) => stage.groups);
}

function tableRows(doc: ActionDoc, key: StageKey): DocRow[] {
  return groupsOf(doc, key).flatMap((group) => group.table?.rows ?? []);
}

/** Markdown cell -> text for a test title: no emphasis, no backticks. */
function plain(text: DocLine['text']): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
