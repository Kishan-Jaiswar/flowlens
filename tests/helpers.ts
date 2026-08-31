import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scan, type ScanResult } from '@flowslens/core';

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled example app: Next-style React + NestJS + Mongoose, source only. */
export const EXAMPLE_ROOT = resolve(here, '..', 'examples', 'crud');

let cached: ScanResult | undefined;

/**
 * Scan the example once and share it.
 *
 * Every analyzer test asks a different question of the same graph, and scanning
 * is the slow part.
 */
export function exampleScan(): ScanResult {
  if (!cached) cached = scan({ root: EXAMPLE_ROOT });
  return cached;
}
