/**
 * Box-drawing characters, and an ASCII fallback for terminals that cannot show
 * them.
 *
 * FlowLens draws trees. On Linux, macOS, Windows Terminal, VS Code and every
 * modern emulator the Unicode set is correct and much easier to read. The one
 * place it fails is the legacy Windows console (`conhost.exe` with a raster
 * font), where `▼` and `⚠` come out as hollow boxes — so on that terminal, and
 * only there, the same trees are drawn with `|`, `` ` `` and `v`.
 *
 * Every ASCII glyph is the same display width as the Unicode one it replaces,
 * so column alignment holds either way.
 */

export interface Glyphs {
  /** Tree branch, e.g. `├── [handler] onSubmit`. */
  branch: string;
  /** Last branch of a group. */
  lastBranch: string;
  /** Continuation line under a non-last branch. */
  vertical: string;
  /** Flow direction between layers. */
  down: string;
  /** Horizontal rule, repeated. */
  rule: string;
  /** Data lineage arrow. */
  arrow: string;
  /** Two-way relationship, as in "frontend ↔ backend". */
  exchange: string;
  /** Something is wrong. */
  warn: string;
  /** List bullet. */
  bullet: string;
  /** Quieter list bullet. */
  dot: string;
  /** Stands in for an empty value in a table cell. */
  none: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  branch: '├──',
  lastBranch: '└──',
  vertical: '│',
  down: '▼',
  rule: '─',
  arrow: '→',
  exchange: '↔',
  warn: '⚠',
  bullet: '•',
  dot: '·',
  none: '—',
};

export const ASCII_GLYPHS: Glyphs = {
  branch: '|--',
  lastBranch: '`--',
  vertical: '|',
  down: 'v',
  rule: '-',
  arrow: '->',
  exchange: '<>',
  warn: '!',
  bullet: '*',
  dot: '-',
  none: '-',
};

export interface AsciiProbe {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Whether output is going to a terminal rather than a file or a pipe. */
  isTTY?: boolean;
}

/**
 * Should output avoid box-drawing characters?
 *
 * Only when writing to a *terminal* — a redirected file or a pipe gets UTF-8
 * bytes that whatever reads them can decode, and downgrading those would make
 * generated documents worse to look at for no gain. That also keeps output
 * identical across operating systems in CI, where nothing is a TTY.
 *
 * `FLOWLENS_ASCII=1` forces the fallback on; `FLOWLENS_UNICODE=1` forces it off
 * and wins, so a user on an unusual terminal can always get the output they
 * want.
 */
export function preferAscii(probe: AsciiProbe = {}): boolean {
  const env = probe.env ?? process.env;
  const platform = probe.platform ?? process.platform;
  const isTTY = probe.isTTY ?? process.stdout.isTTY === true;

  if (isTruthy(env['FLOWLENS_UNICODE'])) return false;
  if (isTruthy(env['FLOWLENS_ASCII'])) return true;
  if (platform !== 'win32' || !isTTY) return false;

  // Windows Terminal, VS Code, ConEmu, Git Bash and friends all identify
  // themselves and all render Unicode. A bare conhost sets none of these.
  const modern = [
    'WT_SESSION',
    'TERM_PROGRAM',
    'ConEmuANSI',
    'TERM',
    'WEZTERM_PANE',
    'ALACRITTY_WINDOW_ID',
  ];
  return !modern.some((name) => env[name]);
}

export function glyphsFor(ascii: boolean): Glyphs {
  return ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}
