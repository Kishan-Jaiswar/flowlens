import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

/**
 * Which side of the app a file belongs to.
 *
 * Decided from the file's *contents*, not its folder name. Folder names are the
 * least reliable thing about a real repository: `api/` is a Nest backend in one
 * project, an axios client in the next, and Next.js route handlers in a third.
 * An earlier version keyed off the path and silently dropped every API call in
 * any frontend that kept its client in `src/api/`.
 */
export type FileSide = 'frontend' | 'server' | 'shared';

/** Decorators that only exist in server frameworks. */
const SERVER_DECORATORS = new Set([
  'Controller',
  'Injectable',
  'Module',
  'Schema',
  'Entity',
  'Resolver',
  'Catch',
  'WebSocketGateway',
  'SubscribeMessage',
  'Processor',
]);

/** Modules that can only be imported by server code. */
const SERVER_MODULES = [
  /^@nestjs\//,
  /^express$/,
  /^fastify$/,
  /^koa$/,
  /^@hapi\//,
  /^restify$/,
  /^mongoose$/,
  /^mongodb$/,
  /^typeorm$/,
  /^sequelize$/,
  /^@prisma\/client$/,
  /^knex$/,
  /^pg$/,
  /^mysql2?$/,
  /^ioredis$/,
  /^bullmq$/,
  /^node:/,
];

/** Modules that only make sense in a browser bundle. */
const CLIENT_MODULES = [
  /^react$/,
  /^react-dom/,
  /^next\//,
  /^vue$/,
  /^svelte/,
  /^@angular\//,
  /^@tanstack\/react/,
  /^react-router/,
  /^@mui\//,
  /^@emotion\//,
];

/** Next.js and Nuxt route handler locations. */
const NEXT_PAGES_API = /(^|\/)pages\/api\//;
const NEXT_APP_ROUTE = /(^|\/)app\/.*\/route\.[cm]?[jt]sx?$/;
const NEXT_APP_ROUTE_ROOT = /(^|\/)app\/route\.[cm]?[jt]sx?$/;
const NUXT_SERVER_API = /(^|\/)server\/(api|routes)\//;

export interface Classification {
  side: FileSide;
  /** True for a Next.js/Nuxt file-system route handler. */
  isFileRoute: boolean;
  /** Why it was classified this way — surfaced by `--explain`. */
  reason: string;
}

/**
 * Classify a file.
 *
 * Ordered by how much a signal can be trusted: framework decorators and
 * file-system route conventions are conclusive, imports are strong, and naming
 * is only consulted when nothing else applies.
 */
export function classifyFile(file: SourceFile, rel: string): Classification {
  // 1. File-system routes are server code by convention, wherever they sit.
  if (isFileSystemRoute(rel)) {
    return { side: 'server', isFileRoute: true, reason: 'file-system route handler' };
  }

  // 2. Framework decorators are conclusive.
  for (const declaration of file.getClasses()) {
    for (const decorator of declaration.getDecorators()) {
      if (SERVER_DECORATORS.has(decorator.getName())) {
        return {
          side: 'server',
          isFileRoute: false,
          reason: `@${decorator.getName()} decorator`,
        };
      }
    }
  }

  const specifiers = importSpecifiers(file);
  const hasJsx = containsJsx(file);

  // 3. A file with JSX is a component, even if it also talks to a database
  //    helper — the rendering is the part FlowLens cares about.
  if (hasJsx) {
    return { side: 'frontend', isFileRoute: false, reason: 'contains JSX' };
  }

  const serverImport = specifiers.find((name) => SERVER_MODULES.some((p) => p.test(name)));
  const clientImport = specifiers.find((name) => CLIENT_MODULES.some((p) => p.test(name)));

  // 4. Imports. A client import wins a tie: `react` plus `node:crypto` is a
  //    hook that happens to hash something.
  if (clientImport) {
    return { side: 'frontend', isFileRoute: false, reason: `imports ${clientImport}` };
  }
  if (serverImport) {
    return { side: 'server', isFileRoute: false, reason: `imports ${serverImport}` };
  }

  // 5. Naming, as a last resort.
  for (const declaration of file.getClasses()) {
    const name = declaration.getName() ?? '';
    if (/(Controller|Service|Repository|Gateway|Resolver|Middleware|Guard)$/.test(name)) {
      return { side: 'server', isFileRoute: false, reason: `class named ${name}` };
    }
  }

  // Constants, utilities, types: analyzed by both passes, harmless to either.
  return { side: 'shared', isFileRoute: false, reason: 'no framework signals' };
}

export function isFileSystemRoute(rel: string): boolean {
  return (
    NEXT_PAGES_API.test(rel) ||
    NEXT_APP_ROUTE.test(rel) ||
    NEXT_APP_ROUTE_ROOT.test(rel) ||
    NUXT_SERVER_API.test(rel)
  );
}

/** Should the frontend pass read this file? */
export function isFrontendCandidate(classification: Classification): boolean {
  return classification.side === 'frontend' || classification.side === 'shared';
}

/** Should the backend pass read this file? */
export function isServerCandidate(classification: Classification): boolean {
  return classification.side === 'server' || classification.side === 'shared';
}

function importSpecifiers(file: SourceFile): string[] {
  const specifiers: string[] = [];
  for (const declaration of file.getImportDeclarations()) {
    specifiers.push(declaration.getModuleSpecifierValue());
  }
  // CommonJS: `const x = require('express')`
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'require') continue;
    const [argument] = call.getArguments();
    if (argument && Node.isStringLiteral(argument)) specifiers.push(argument.getLiteralValue());
  }
  return specifiers;
}

function containsJsx(file: SourceFile): boolean {
  return (
    file.getFirstDescendant(
      (node) =>
        Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node),
    ) !== undefined
  );
}
