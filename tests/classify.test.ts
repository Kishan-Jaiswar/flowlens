import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '@flowslens/core';

/**
 * A Next.js request helper imports `NextRequest` from `next/server`. That is a
 * server-only module: read as browser code, the helper was skipped, and the
 * access check every route runs through it — and the queries behind it — never
 * reached a route.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-classify-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const app = project({
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0', mongodb: '6.0.0' } }),
  'lib/db/access.ts': `
    import { MongoClient } from "mongodb";
    const db = new MongoClient("x").db();
    export async function hasAccess(user: string, team: string) {
      const found = await db.collection("memberships").find({ user, team }).toArray();
      return found.length > 0;
    }`,
  'lib/db/reports.ts': `
    import { MongoClient } from "mongodb";
    const db = new MongoClient("x").db();
    export async function listReports(team: string) {
      return db.collection("reports").find({ team }).toArray();
    }`,
  'lib/api/server.ts': `
    import type { NextRequest } from "next/server";
    import { hasAccess } from "@/lib/db/access";
    export async function requireTeam(request: NextRequest) {
      const team = request.headers.get("x-team") ?? "";
      if (!(await hasAccess("me", team))) return { error: new Response(null, { status: 403 }) };
      return { team };
    }`,
  'app/api/reports/route.ts': `
    import type { NextRequest } from "next/server";
    import { requireTeam } from "@/lib/api/server";
    import { listReports } from "@/lib/db/reports";
    export async function GET(request: NextRequest) {
      const ctx = await requireTeam(request);
      if ("error" in ctx) return ctx.error;
      return Response.json(await listReports(ctx.team));
    }`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
});

describe('a module importing next/server is server code', () => {
  const { graph } = scan({ root: app });

  it('follows a route through its request helper to the queries the helper runs', () => {
    const route = graph.nodesOfKind('route').find((node) => node.label === 'GET /reports')!;
    const reached = [...graph.reachable(route.id).keys()]
      .map((id) => graph.node(id))
      .filter((node) => node?.kind === 'db-op')
      .map((node) => node!.label)
      .sort();
    expect(reached).toEqual(['memberships.find', 'reports.find']);
  });

  it('keeps the helper as a step of its own', () => {
    expect(graph.nodesOfKind('method').map((node) => node.label)).toContain('requireTeam');
  });
});
