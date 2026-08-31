/** Terminal output helpers: colour when it helps, plain text when piped. */

import { glyphsFor, preferAscii } from '@flowslens/core';

const useColor =
  process.stdout.isTTY === true &&
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb';

/**
 * Whether this terminal can draw box characters.
 *
 * Read once at startup: nothing about the terminal changes mid-command, and
 * every table and tree needs the answer.
 */
export const ascii = preferAscii();

/** The glyph set for this terminal — Unicode almost everywhere, ASCII on a legacy Windows console. */
export const glyph = glyphsFor(ascii);

const wrap = (code: string) => (text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function heading(text: string): string {
  return `\n${color.bold(text)}\n${color.gray(glyph.rule.repeat(Math.min(text.length, 60)))}`;
}

export function riskBadge(level: 'low' | 'medium' | 'high'): string {
  if (level === 'high') return color.red('high');
  if (level === 'medium') return color.yellow('medium');
  return color.green('low');
}

export function evidenceBadge(evidence: 'static' | 'runtime' | 'confirmed'): string {
  if (evidence === 'confirmed') return color.green('confirmed');
  if (evidence === 'runtime') return color.cyan('runtime');
  return color.gray('static');
}

/** Render a simple aligned table. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return '';
  const columns = Math.max(...all.map((row) => row.length));
  const widths: number[] = [];
  for (let i = 0; i < columns; i += 1) {
    widths[i] = Math.max(...all.map((row) => visibleLength(row[i] ?? '')));
  }

  const lines: string[] = [];
  if (headers) {
    lines.push(headers.map((cell, i) => color.bold(pad(cell, widths[i] ?? 0))).join('  '));
    lines.push(widths.map((width) => color.gray(glyph.rule.repeat(width))).join('  '));
  }
  for (const row of rows) {
    lines.push(
      row
        .map((cell, i) => pad(cell ?? '', widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    );
  }
  return lines.join('\n');
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/**
 * Length ignoring ANSI escapes, so colour does not break table alignment.
 *
 * The escape character is the entire point of this pattern, so the
 * control-character rule is suppressed rather than worked around.
 */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function fail(message: string): never {
  process.stderr.write(`${color.red('error')} ${message}\n`);
  process.exit(1);
}
