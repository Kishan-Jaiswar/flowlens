import { projectUnused, scan, type ProjectUnused } from '@flowslens/core';
import { color, heading, table } from '../ui.js';

export interface UnusedArgs {
  root: string;
  extraRoots?: string[];
  json?: boolean;
  /** Also list exports only used inside their own file. */
  all?: boolean;
}

/**
 * `flowlens unused` — code nothing uses.
 *
 * Files no entry point reaches, folders made only of them, exports nothing
 * imports, dependencies nothing imports, relative imports that point at no
 * file, and backend routes no frontend calls. Read from the source; nothing is
 * deleted — the answer is a list to check, and it says what it cannot see.
 */
export function runUnused(args: UnusedArgs): number {
  const graph = scan({
    root: args.root,
    ...(args.extraRoots ? { extraRoots: args.extraRoots } : {}),
  }).graph;
  const report = projectUnused(graph);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderUnused(report, args.all === true));
  return 0;
}

/** Headers first, the way the call sites read. */
const grid = (headers: string[], rows: string[][]): string => table(rows, headers);

export function renderUnused(report: ProjectUnused, all: boolean): string {
  const out: string[] = [];
  const exports = all ? report.exports : report.exports.filter((entry) => !entry.usedInFile);
  const internal = report.exports.length - exports.length;
  const lines = report.files.reduce((sum, entry) => sum + entry.lines, 0);

  out.push(
    '',
    color.bold(
      `${report.files.length} unused file${report.files.length === 1 ? '' : 's'}` +
        (lines ? ` (${lines} lines)` : '') +
        ` · ${exports.length} unused export${exports.length === 1 ? '' : 's'}` +
        ` · ${report.dependencies.length} unused dependenc${report.dependencies.length === 1 ? 'y' : 'ies'}` +
        ` · ${report.endpoints.length} endpoint${report.endpoints.length === 1 ? '' : 's'} nothing calls`,
    ),
    color.gray(
      `  ${report.checked.files} files checked, from ${report.checked.entries} entry points`,
    ),
    '',
  );

  if (report.broken.length) {
    out.push(heading('Imports that point at nothing'));
    out.push(
      grid(
        ['File', 'Imports'],
        report.broken.map((entry) => [entry.file, color.red(entry.specifier)]),
      ),
      '',
    );
  }
  if (report.folders.length) {
    out.push(heading('Folders nothing uses'));
    out.push(
      grid(
        ['Folder', 'Files', 'Lines'],
        report.folders.map((entry) => [
          `${entry.folder}/`,
          String(entry.files),
          String(entry.lines),
        ]),
      ),
      '',
    );
  }
  const inFolders = (file: string) =>
    report.folders.some((entry) => file.startsWith(`${entry.folder}/`));
  const loose = report.files.filter((entry) => !inFolders(entry.file));
  if (loose.length) {
    out.push(heading('Files nothing uses'));
    out.push(
      grid(
        ['File', 'Lines'],
        loose.map((entry) => [entry.file, String(entry.lines)]),
      ),
      '',
    );
  }
  if (exports.length) {
    out.push(heading('Exports nothing imports'));
    out.push(
      grid(
        ['Where', 'Export', 'Kind', ''],
        exports.map((entry) => [
          `${entry.file}:${entry.line}`,
          entry.name,
          entry.kind,
          entry.usedInFile ? color.gray('used in its file — drop `export`') : 'dead',
        ]),
      ),
    );
    if (internal > 0) {
      out.push(
        color.gray(
          `  +${internal} used only inside their own file (the \`export\` can go) — --all lists them`,
        ),
      );
    }
    out.push('');
  }
  if (report.dependencies.length) {
    out.push(heading('Dependencies nothing imports'));
    out.push(
      grid(
        ['Package', 'Version', 'In'],
        report.dependencies.map((entry) => [entry.name, entry.version, entry.manifest]),
      ),
      '',
    );
  }
  if (report.endpoints.length) {
    out.push(heading('Endpoints no frontend calls'));
    out.push(
      grid(
        ['Route', 'Where'],
        report.endpoints.map((entry) => [
          entry.label,
          entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}` : '',
        ]),
      ),
      color.gray(
        '  Another app, a webhook or a mobile client may call these — check before removing.',
      ),
      '',
    );
  }
  for (const note of report.notes) out.push(color.gray(note));
  out.push('');
  return out.join('\n');
}
