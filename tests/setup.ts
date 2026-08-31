import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Keep the suite out of the developer's real artifact cache.
 *
 * FlowLens writes its graph to the OS cache directory rather than into the
 * project it scans. Tests scan throwaway fixtures, so without this every run
 * would orphan an entry in `~/.cache/flowlens`. Child processes spawned by the
 * tests inherit this, which is what makes it cover the CLI too.
 */
process.env['FLOWLENS_CACHE'] = mkdtempSync(join(tmpdir(), 'flowlens-cache-'));
