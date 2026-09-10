import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, scan } from '@flowslens/core';
import {
  hostAllowed,
  hostnameOf,
  isLoopbackHost,
  originAllowed,
  tokenMatches,
} from '../packages/cli/dist/commands/serve.js';

/**
 * The rules behind the dashboard's access control, tested as functions.
 *
 * `tests/server.test.ts` drives the real server and proves the rules are wired
 * up; these cover the edges that are awkward to reach over HTTP — IPv6
 * spellings, a `null` origin, a token of the wrong length.
 */

describe('which binds count as private', () => {
  it('recognises loopback in every spelling', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('treats anything routable as public', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'dev.local']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('the Host header', () => {
  it('is read without its port or brackets', () => {
    expect(hostnameOf('127.0.0.1:4177')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:4177')).toBe('::1');
    expect(hostnameOf('localhost')).toBe('localhost');
    expect(hostnameOf(undefined)).toBeUndefined();
    expect(hostnameOf('')).toBeUndefined();
  });

  it('accepts an address, and localhost, and the host we bound', () => {
    expect(hostAllowed('127.0.0.1:4177', '127.0.0.1')).toBe(true);
    expect(hostAllowed('localhost:4177', '127.0.0.1')).toBe(true);
    expect(hostAllowed('[::1]:4177', '127.0.0.1')).toBe(true);
    expect(hostAllowed('192.168.1.10:4177', '0.0.0.0')).toBe(true);
    // A name someone deliberately bound to is still theirs to use.
    expect(hostAllowed('dev.box:4177', 'dev.box')).toBe(true);
  });

  it('rejects a name, which is the only thing an attacker can rebind', () => {
    expect(hostAllowed('evil.example', '127.0.0.1')).toBe(false);
    expect(hostAllowed('evil.example:4177', '127.0.0.1')).toBe(false);
    expect(hostAllowed(undefined, '127.0.0.1')).toBe(false);
  });
});

describe('the Origin header', () => {
  it('allows a request that has none — curl, a script, a navigation', () => {
    expect(originAllowed(undefined, '127.0.0.1:4177')).toBe(true);
  });

  it('allows the dashboard talking to itself', () => {
    expect(originAllowed('http://127.0.0.1:4177', '127.0.0.1:4177')).toBe(true);
  });

  it('rejects every other page', () => {
    expect(originAllowed('https://evil.example', '127.0.0.1:4177')).toBe(false);
    // A different port on this machine is a different origin, and a different app.
    expect(originAllowed('http://127.0.0.1:3000', '127.0.0.1:4177')).toBe(false);
    // Sandboxed iframes and file:// pages send this.
    expect(originAllowed('null', '127.0.0.1:4177')).toBe(false);
    expect(originAllowed('not a url', '127.0.0.1:4177')).toBe(false);
  });
});

describe('the token', () => {
  it('matches only itself', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true);
    expect(tokenMatches('secrez', 'secret')).toBe(false);
    // Different lengths must not throw — timingSafeEqual insists on equal ones.
    expect(tokenMatches('short', 'a much longer token')).toBe(false);
    expect(tokenMatches('', 'secret')).toBe(false);
    expect(tokenMatches(undefined, 'secret')).toBe(false);
  });
});

describe('a config file is found, not asked for', () => {
  const temp = mkdtempSync(join(tmpdir(), 'flowlens-config-trust-'));

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  const withConfig = (name: string, config: Record<string, unknown>): string => {
    const dir = join(temp, name, 'repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'flowlens.config.json'), JSON.stringify(config), 'utf8');
    return dir;
  };

  it('says nothing about the ordinary layouts', () => {
    const own = withConfig('own', { roots: ['.'] });
    expect(loadConfig(own).warnings).toBeUndefined();

    // The documented two-repository setup: a sibling is not suspicious.
    const sibling = withConfig('sibling', { roots: ['.', '../api'] });
    expect(loadConfig(sibling).warnings).toBeUndefined();
  });

  it('warns when a root reaches outside the project', () => {
    const far = withConfig('far', { roots: ['/'] });
    const warnings = loadConfig(far).warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('outside its own project');

    const up = withConfig('up', { roots: ['../../../..'] });
    expect(loadConfig(up).warnings ?? []).toHaveLength(1);
  });
});

describe('a pattern from a config file', () => {
  it('is refused before it is compiled if it is absurdly long', () => {
    // Nested quantifiers are the classic catastrophic shape; the length cap is
    // what keeps one out of the matcher in the first place.
    const pattern = `^(a+)+${'x'.repeat(600)}$`;
    expect(() => scan({ root: 'examples/crud', requestFunctionPattern: pattern })).toThrow(
      /the limit is 500/,
    );
  });

  it('still refuses one that is short but invalid', () => {
    expect(() => scan({ root: 'examples/crud', requestFunctionPattern: '^(' })).toThrow(
      /not a valid regular expression/,
    );
  });
});
