import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

describe('release versions', () => {
  // 1.3.0 bumped every version but left the CLI pinned to core 1.2.0, so the
  // published CLI installed a core without the exports it imports.
  it('pins the CLI to the core it is built against', () => {
    const cli = manifest('packages/cli/package.json');
    const core = manifest('packages/core/package.json');
    expect(cli.dependencies['@flowslens/core']).toBe(core.version);
  });

  it('keeps the three packages on one version', () => {
    const versions = ['cli', 'core', 'runtime'].map(
      (name) => manifest(`packages/${name}/package.json`).version,
    );
    expect(new Set(versions).size).toBe(1);
  });

  it('links the workspace core rather than installing a published copy', () => {
    const lock = manifest('package-lock.json');
    expect(Object.keys(lock.packages)).not.toContain('packages/cli/node_modules/@flowslens/core');
  });
});
