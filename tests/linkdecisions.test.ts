import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkDecisions, resolveFlows, scan, type DecisionNode } from '@flowslens/core';

/**
 * A link's Decisions tab: the path its value takes, not the whole page's tree.
 * The shape is a stock list's "Low" tile — `/items?level=low` — read by the
 * page, sent to the API, and turned into a filter by a `switch` in the store.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-linkdec-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const app = project({
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
  'app/items/page.tsx': `
    "use client";
    export default function ItemsPage() {
      const params = useSearchParams();
      const [level] = useState(params.get("level") ?? "");
      useEffect(() => {
        fetch("/api/meta");
        fetch(\`/api/items?level=\${level}\`);
      }, [level]);
      return <div>Items</div>;
    }`,
  'app/api/meta/route.ts': `
    export async function GET(request) {
      return Response.json({ categories: [] });
    }`,
  'app/api/items/route.ts': `
    import { listItems } from "../../../lib/store";
    import { requireUser } from "../../../lib/auth";
    export async function GET(request) {
      const user = await requireUser(request);
      if (!user) return Response.json({ error: "Sign in" }, { status: 401 });
      const url = new URL(request.url);
      const query = { level: url.searchParams.get("level") };
      return Response.json(await listItems(query));
    }`,
  'lib/auth.ts': `
    function readToken(request, kind) {
      if (kind !== "access") return null;
      return request.headers.get("authorization");
    }
    export async function requireUser(request) {
      const token = readToken(request, "access");
      if (!token) return null;
      return db.collection("sessions").findOne({ token });
    }`,
  'lib/store.ts': `
    function levelClauses(level) {
      switch (level) {
        case "out":
          return [{ stock: { $lte: 0 } }];
        case "low":
          return [{ stock: { $gt: 0 } }, { $expr: { $lte: ["$stock", "$minimum"] } }];
        default:
          return [{ stock: { $gt: 0 } }];
      }
    }
    export async function listItems(query) {
      const and = [];
      if (query.level) and.push(...levelClauses(query.level));
      return db.collection("items").find({ $and: and }).toArray();
    }`,
});

const { graph } = scan({ root: app });
const flow = resolveFlows(graph, { includeLocalOnly: true }).find(
  (candidate) => candidate.event === 'mount' && candidate.endpoints.includes('GET /items'),
)!;
const tree = linkDecisions(graph, flow, {
  label: 'Low',
  href: '/items?level=low',
  from: 'Needs attention',
});

/** The tree as lines: `• step`, `◆ question`, `├ branch`, `▣ request`, `■ end`. */
function lines(nodes: DecisionNode[], depth = 0): string[] {
  const pad = '  '.repeat(depth);
  return nodes.flatMap((node) => {
    if (node.type === 'decision') {
      return [
        `${pad}◆ ${node.label}`,
        ...node.branches.flatMap((branch) => [
          `${pad}├ ${branch.label}`,
          ...lines(branch.nodes, depth + 1),
        ]),
      ];
    }
    if (node.type === 'group') return [`${pad}▣ ${node.label}`, ...lines(node.nodes, depth + 1)];
    if (node.type === 'end') return [`${pad}■ ${node.label}`];
    if (node.type === 'try') return lines(node.nodes, depth);
    return [`${pad}• ${node.label}`];
  });
}

describe('linkDecisions', () => {
  const drawn = lines(tree.nodes);

  it('starts with the click and the address it opens, and the page reading the value', () => {
    expect(drawn.slice(0, 3)).toEqual([
      '• You click “Low” on Needs attention',
      '• The browser opens /items with the filter in the address',
      '• The page reads level from the address: “low”',
    ]);
  });

  it('draws only the request that carries the value, not the page’s other requests', () => {
    expect(drawn.filter((line) => line.startsWith('▣'))).toEqual([
      '▣ Send GET /items to the server',
    ]);
    expect(drawn.join('\n')).not.toContain('/meta');
  });

  it('carries the value through the request and draws only the way it goes', () => {
    const text = drawn.join('\n');
    // `if (query.level)` and `switch (level)` are both settled by "low": no questions left.
    expect(text).not.toContain('◆');
    expect(tree.counts.decisions).toBe(0);
    // The helper the value is passed to, by its parameter, and the case it picks.
    expect(text).toContain('▣ Run level clauses');
    const clauses = (tree.nodes[3] as Extract<DecisionNode, { type: 'group' }>).nodes[0] as Extract<
      DecisionNode,
      { type: 'group' }
    >;
    const inner = (clauses.nodes[0] as Extract<DecisionNode, { type: 'group' }>).nodes;
    expect(inner).toHaveLength(1);
    expect((inner[0] as { text: string }).text).toContain('"$minimum"');
  });

  it('leaves out what runs the same however the page is opened: signing in, its query, its checks', () => {
    const text = drawn.join('\n');
    expect(text).not.toMatch(/require user|read token/i);
    expect(text).not.toContain('sessions');
    expect(text).not.toContain('401');
  });

  it('ends with the page showing what matched', () => {
    expect(drawn[drawn.length - 1]).toBe('• The page shows only what matches level “low”');
  });

  it('takes another link down its own case, and an unknown value down the default', () => {
    const caseText = (href: string) => {
      const other = linkDecisions(graph, flow, { label: 'x', href });
      return JSON.stringify(other.nodes);
    };
    expect(caseText('/items?level=out')).toContain('$lte: 0');
    expect(caseText('/items?level=out')).not.toContain('$minimum');
    expect(caseText('/items?level=zzz')).not.toContain('$lte: 0');
    expect(caseText('/items?level=zzz')).not.toContain('$minimum');
  });
});
