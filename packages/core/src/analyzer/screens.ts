/**
 * Where in the product does this click live?
 *
 * A user action labelled `Submit` is useless on its own: a real app has fifteen
 * of them. What a developer needs on the tile is the same phrase they would say
 * out loud — "the submit on the order screen" — so every `ui-action`
 * node carries a *screen* alongside its action text, and the two are composed
 * into a title: `Order · Submit`.
 *
 * The screen is derived from the path on disk, which is where framework
 * conventions already record it:
 *
 *   pages/order/[id].js        ->  Order   (route segment)
 *   app/billing/invoices/page.tsx     ->  Invoices       (route segment)
 *   components/order/Sku.js     ->  Order   (feature folder)
 *   components/Buttons.js             ->  Buttons        (component name)
 *
 * Nothing here needs the module graph, so it holds for a component defined in
 * one file and rendered from twenty pages: the answer is stable, and it is the
 * answer a developer grepping the repo would give.
 */

/**
 * Directory names that describe the *shape* of the code rather than the part of
 * the product it serves. A screen called "Components" tells nobody anything.
 */
const GENERIC_DIRS = new Set([
  'app',
  'client',
  'common',
  'components',
  'containers',
  'core',
  'features',
  'frontend',
  'helpers',
  'hoc',
  'hooks',
  'layouts',
  'lib',
  'misc',
  'modules',
  'pages',
  'partials',
  'screens',
  'shared',
  'src',
  'ui',
  'utils',
  'views',
  'web',
  'widgets',
]);

/** File basenames that name the framework's plumbing, not a screen. */
const FRAMEWORK_FILES = new Set([
  '_app',
  '_document',
  '_error',
  'error',
  'layout',
  'loading',
  'middleware',
  'not-found',
  'page',
  'route',
  'template',
]);

/** Words a developer would not capitalise the lazy way. */
const ACRONYMS = new Map([
  ['crm', 'CRM'],
  ['ai', 'AI'],
  ['api', 'API'],
  ['csv', 'CSV'],
  ['faq', 'FAQ'],
  ['seo', 'SEO'],
  ['id', 'ID'],
  ['otp', 'OTP'],
  ['pdf', 'PDF'],
  ['qr', 'QR'],
  ['sku', 'SKU'],
  ['sms', 'SMS'],
  ['ui', 'UI'],
  ['url', 'URL'],
]);

/** Folders that group markup by size rather than by feature. */
const NOISE_DIRS = /^(parts|sections|elements|fragments|blocks|cards|popups|modals|tabs)$/i;

/**
 * Words too generic to prove that two names talk about the same thing: a
 * "Order form" and a "Billing form" share only the word `form`.
 */
const WEAK_WORDS = new Set([
  'a',
  'and',
  'button',
  'card',
  'dialog',
  'form',
  'list',
  'modal',
  'my',
  'new',
  'of',
  'page',
  'panel',
  'popup',
  'screen',
  'section',
  'tab',
  'the',
  'to',
  'view',
]);

const ACRONYM_VALUES = new Set(ACRONYMS.values());

/** The default separator between screen and action: `Order · Submit`. */
export const TITLE_SEPARATOR = ' · ';

export interface ScreenName {
  /** Human phrase for the part of the product: `Edit shipment`. */
  screen: string;
  /** Route the page serves, when the file is a page: `/edit-shipment`. */
  page?: string;
  /** Feature folder the file sits in, when it is not a page: `order`. */
  area?: string;
}

/**
 * Name the screen a source file belongs to.
 *
 * `componentName` is the fallback, not the first choice: `RxFooter` in
 * `components/order/` is part of the order screen, and that is
 * what a reader of the tile wants to see.
 */
export function screenOf(rel: string, componentName?: string): ScreenName {
  const normalized = rel.split('\\').join('/');
  const page = pageRouteOf(normalized);

  if (page !== undefined) {
    return {
      screen: screenPhrase(meaningfulSegments(page.split('/'))),
      page: `/${page}`,
    };
  }

  const area = featureFolderOf(normalized);
  if (area) return { screen: humanizeName(area), area };

  const base = componentName ?? basenameOf(normalized);
  return { screen: humanizeName(base) };
}

/**
 * The route a page file serves, without leading slash: `edit-shipment/:id`.
 *
 * Returns undefined for anything that is not a page — including `pages/api/**`,
 * which is a backend route and is handled by the file-route analyzer.
 */
export function pageRouteOf(rel: string): string | undefined {
  const normalized = rel.split('\\').join('/');
  if (/(?:^|\/)pages\/api\//.test(normalized)) return undefined;
  if (/(?:^|\/)app\/api\//.test(normalized)) return undefined;

  const match =
    /(?:^|\/)pages\/(.*)$/.exec(normalized) ??
    /(?:^|\/)app\/(.*)\/(?:page|layout|template)\.[cm]?[jt]sx?$/.exec(normalized) ??
    /(?:^|\/)app\/(?:page|layout|template)\.[cm]?[jt]sx?$/.exec(normalized);

  if (!match) return undefined;

  const segments = (match[1] ?? '')
    .replace(/\.[cm]?[jt]sx?$/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    // Route groups `(admin)` and private folders `_lib` are not part of the URL.
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .filter((segment) => !FRAMEWORK_FILES.has(segment))
    // `index` is the directory itself: `pages/billing/index.js` is `/billing`.
    .filter((segment) => segment !== 'index');

  return segments.join('/');
}

/**
 * The folder that names the part of the product a file belongs to.
 *
 * Anchored on the code root — `components`, `src`, `features`, `modules` — and
 * read *from* there, never from the top of the path:
 *
 *   components/order/parts/RxFooter.js  ->  order
 *   src/features/billing/Invoice.tsx           ->  billing
 *   my-repo/components/Buttons.js              ->  undefined (no feature folder)
 *
 * Reading downward is what keeps a repository's own name out of the answer. A
 * multi-root scan prefixes every path with the project folder, so walking up
 * from the file used to hand back "Shop frontend web" as the screen
 * for anything sitting directly in `components/`.
 */
function featureFolderOf(rel: string): string | undefined {
  const directories = rel.split('/').slice(0, -1);

  let root = -1;
  directories.forEach((segment, index) => {
    if (GENERIC_DIRS.has(segment.toLowerCase())) root = index;
  });
  // No recognisable code root: better to say nothing than to name the screen
  // after whatever directory the project happens to live in.
  if (root === -1) return undefined;

  for (let index = root + 1; index < directories.length; index += 1) {
    const segment = directories[index] ?? '';
    if (usableFolder(segment)) return segment;
  }

  /**
   * Nothing below the root. A feature-first layout
   * (`billing/components/Invoice.tsx`) does keep the answer one level *above*
   * it, but that path is indistinguishable from a multi-root scan's
   * `my-repo/components/Invoice.tsx`, where the same guess would name every
   * screen after the repository. The component's own name is less specific and
   * always right, so it wins.
   */
  return undefined;
}

function usableFolder(segment: string): boolean {
  if (!isMeaningfulSegment(segment)) return false;
  if (GENERIC_DIRS.has(segment.toLowerCase())) return false;
  return !NOISE_DIRS.test(segment);
}

/** Route segments worth naming a screen after: drops `index` and `[id]`. */
function meaningfulSegments(segments: string[]): string[] {
  return segments.filter((segment) => isMeaningfulSegment(segment) && segment !== 'index');
}

/**
 * `['order', 'create']` -> `Order create`.
 *
 * The last two segments, not just the last, because half the routes in a real
 * app end in a verb: `order/create` is a screen, `create` is not. A
 * parent that merely repeats its child (`billing/billing-list`) is dropped.
 */
function screenPhrase(segments: string[]): string {
  const tail = segments.slice(-2);
  if (tail.length === 0) return 'Home';
  if (tail.length === 2) {
    const [parent, child] = tail as [string, string];
    if (mentions(child, parent) || mentions(parent, child)) return humanizeName(child);
    return `${humanizeName(parent)} ${lowerFirst(humanizeName(child))}`;
  }
  return humanizeName(tail[0] as string);
}

/** Mid-sentence form of a phrase, leaving an acronym (`SKU`, `CRM`) alone. */
function lowerFirst(phrase: string): string {
  const [first = ''] = phrase.split(' ');
  if (ACRONYM_VALUES.has(first)) return phrase;
  return `${first.charAt(0).toLowerCase()}${first.slice(1)}${phrase.slice(first.length)}`;
}

function isMeaningfulSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === '.' || segment === '..') return false;
  // `[id]`, `[...slug]` and `:param` identify a record, not a screen.
  if (/^\[.*\]$/.test(segment) || segment.startsWith(':') || segment === '*') return false;
  if (segment.startsWith('_')) return false;
  return true;
}

function basenameOf(rel: string): string {
  const last = rel.split('/').pop() ?? rel;
  return last.replace(/\.[cm]?[jt]sx?$/, '');
}

/**
 * `edit-shipment` -> `Edit shipment`, `SkuScreen` -> `SKU screen`.
 *
 * One sentence-cased phrase, because a tile is read as prose. Known acronyms
 * keep their capitals so `seo_dashboard` does not become "Seo dashboard".
 */
export function humanizeName(text: string): string {
  const words = text
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);

  if (words.length === 0) return text;

  const spelled = words.map((word) => ACRONYMS.get(word.toLowerCase()) ?? word.toLowerCase());
  const [first, ...rest] = spelled;
  const head = ACRONYMS.has((words[0] ?? '').toLowerCase())
    ? (first as string)
    : `${(first as string).charAt(0).toUpperCase()}${(first as string).slice(1)}`;
  return [head, ...rest].join(' ');
}

/** `onClick` -> `click`: the gesture, in the words a user would use. */
export function eventVerb(event: string): string {
  if (event === 'mount') return 'loads';
  return event
    .replace(/^on/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

/**
 * Compose the tile title: `Order · Submit`.
 *
 * When the action text already says where it is ("Submit Order"), the
 * screen is dropped rather than repeated — a tile reading "Order ·
 * Submit Order" is worse than the action alone.
 */
export function composeTitle(screen: string, action: string, separator = TITLE_SEPARATOR): string {
  const trimmedAction = action.trim();
  const trimmedScreen = screen.trim();
  if (!trimmedScreen) return trimmedAction;
  if (!trimmedAction) return trimmedScreen;
  if (mentions(trimmedAction, trimmedScreen)) return trimmedAction;
  // "Submit Order" on the order form already says where it is.
  if (words(trimmedAction).length > 1 && sharesSubject(trimmedAction, trimmedScreen)) {
    return trimmedAction;
  }
  return `${trimmedScreen}${separator}${trimmedAction}`;
}

/** Does the action text already contain every word of the screen name? */
function mentions(action: string, screen: string): boolean {
  const haystack = words(action).map(stem);
  return words(screen)
    .map(stem)
    .every((word) => haystack.includes(word));
}

/** Do the two names have a meaningful word in common? */
function sharesSubject(action: string, screen: string): boolean {
  const subject = new Set(
    words(action)
      .filter((word) => !WEAK_WORDS.has(word))
      .map(stem),
  );
  return words(screen)
    .filter((word) => !WEAK_WORDS.has(word))
    .map(stem)
    .some((word) => subject.has(word));
}

/** Crude singular form, so `Customers` and `customer` count as the same word. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}
