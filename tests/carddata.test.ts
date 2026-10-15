import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appSidebar,
  cardData,
  resolveFlows,
  scan,
  SourceReader,
  type SidebarEntry,
} from '@flowslens/core';

/**
 * A dashboard of cards that press nothing: each reads `data` handed down from
 * the page's `useDashboard()`, works a number out of it, and draws it. The
 * shape is a pharmacy app's — a stat card with a status, tiles of links mapped
 * from an array, a list of rows — on a Next.js route whose handler builds the
 * fields in an aggregation.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-card-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const app = project({
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
  'lib/store.ts': `
    export async function getStats(owner: string) {
      const totals = await db.collection("medicines").aggregate([
        { $group: { _id: null,
          totalMedicines: { $sum: 1 },
          lowStockCount: { $sum: { $cond: [{ $lte: ["$currentStock", "$minimumStock"] }, 1, 0] } },
        } },
      ]).next();
      const recent = await db.collection("movements").find({ owner }).limit(5).toArray();
      return {
        totalMedicines: totals.totalMedicines,
        lowStockCount: totals.lowStockCount,
        recent,
      };
    }`,
  'app/api/dashboard/route.ts': `
    import { getStats } from "@/lib/store";
    export async function GET() {
      return Response.json(await getStats("me"));
    }`,
  'features/dashboard/api.ts': `
    import axios from "axios";
    export function useDashboard() {
      return useQuery({
        queryKey: ["dashboard"],
        queryFn: async () => (await axios.get("/api/dashboard")).data,
      });
    }`,
  'components/StatCard.tsx': `
    export function StatCard({ title, value, footer }) {
      return <Card><h3>{title}</h3><p>{value}</p>{footer}</Card>;
    }`,
  'features/dashboard/HealthCard.tsx': `
    import { StatCard } from "@/components/StatCard";
    export function HealthCard({ data }) {
      const total = data.totalMedicines;
      const pct = total > 0 ? Math.round(((total - data.lowStockCount) / total) * 100) : 0;
      const status = pct >= 70 ? { text: "Good" } : { text: "Low" };
      return (
        <StatCard
          title="Stock health"
          value={\`\${pct}%\`}
          footer={<span>{status.text}</span>}
        />
      );
    }`,
  'features/dashboard/AttentionCard.tsx': `
    import Link from "next/link";
    import { StatCard } from "@/components/StatCard";
    export function AttentionCard({ data }) {
      const tiles = [
        { href: "/medicines?filter=low", label: "Low", value: data.lowStockCount },
        { href: "/medicines?filter=all", label: "All", value: data.totalMedicines },
      ];
      return (
        <StatCard
          title="Needs attention"
          footer={
            <div>
              {tiles.map((t) => (
                <Link key={t.label} href={t.href}>
                  <span>{formatNumber(t.value)}</span>
                  <span>{t.label}</span>
                </Link>
              ))}
            </div>
          }
        />
      );
    }`,
  'features/dashboard/WorthCard.tsx': `
    import { useStats } from "@/features/dashboard/useStats";
    export function WorthCard() {
      const stats = useStats();
      const { isLoading } = useStats();
      return (
        <Card title="Inventory worth">
          {isLoading ? <Skeleton /> : <p>{formatNumber(stats.inventoryValue)}</p>}
        </Card>
      );
    }`,
  'features/dashboard/useStats.ts': `
    export function useStats() {
      const [stats, setStats] = useState({ inventoryValue: 0 });
      return stats;
    }`,
  'app/dashboard/page.tsx': `
    "use client";
    import { useDashboard } from "@/features/dashboard/api";
    import { HealthCard } from "@/features/dashboard/HealthCard";
    import { AttentionCard } from "@/features/dashboard/AttentionCard";
    import { WorthCard } from "@/features/dashboard/WorthCard";
    export default function DashboardPage() {
      const { data, isLoading } = useDashboard();
      return isLoading || !data ? (
        <Skeleton />
      ) : (
        <div>
          <Insights data={data} />
          <Card>
            <CardTitle>Recent activity</CardTitle>
            {data.recent.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              data.recent.slice(0, 5).map((m) => <p key={m.id}>{m.reason}</p>)
            )}
          </Card>
        </div>
      );
    }
    function Insights({ data }) {
      return (
        <div>
          <HealthCard data={data} />
          <AttentionCard data={data} />
          <WorthCard />
        </div>
      );
    }`,
  'app/medicines/page.tsx': `
    export default function MedicinesPage() {
      return <div>Medicines</div>;
    }`,
  'app/stock/page.tsx': `
    export default function StockPage() {
      return <div>Stock</div>;
    }`,
  'components/SideMenu.tsx': `
    export function SideMenu() {
      const items = [
        { name: "Dashboard", href: "/dashboard" },
        { name: "Medicines", href: "/medicines" },
        { name: "Stock", href: "/stock" },
      ];
      return <nav>{items.map((item) => <Link key={item.name} href={item.href}>{item.name}</Link>)}</nav>;
    }`,
  'app/layout.tsx': `
    import { SideMenu } from "@/components/SideMenu";
    export default function Layout({ children }) {
      return <div><SideMenu />{children}</div>;
    }`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
});

const { graph } = scan({ root: app });
const flows = resolveFlows(graph, { includeLocalOnly: true });
const reader = new SourceReader(graph);
const sidebar = appSidebar(graph, flows, { reader })!;
const dashboard = sidebar.entries.find((entry) => entry.label === 'Dashboard')!;
const card = (label: string): SidebarEntry =>
  dashboard.children.find((entry) => entry.label === label)!;
const read = (label: string) =>
  cardData(graph, flows, { file: card(label).file!, line: card(label).line! }, { reader })!;

describe('cardData', () => {
  it('places each card by the line it is drawn on', () => {
    expect(card('Stock health').file).toBe('features/dashboard/HealthCard.tsx');
    expect(card('Stock health').line).toBeGreaterThan(0);
  });

  it('follows a value through the calculations and props back to the hook that loads it', () => {
    const health = read('Stock health');
    const value = health.values.find((entry) => entry.label === 'value')!;
    expect(value.code).toBe('`${pct}%`');
    expect(value.fields.sort()).toEqual(['lowStockCount', 'totalMedicines']);
    expect(value.uses).toEqual(expect.arrayContaining(['total', 'pct']));
    expect(health.calculations.map((calc) => calc.name)).toEqual(['total', 'pct', 'status']);
    expect(health.sources).toEqual([
      expect.objectContaining({ hook: 'useDashboard', file: 'app/dashboard/page.tsx' }),
    ]);
  });

  it('names the load and the request the data comes from', () => {
    const [source] = read('Stock health').sources;
    expect(source!.endpoints).toEqual(['GET /dashboard']);
    expect(source!.flows).toHaveLength(1);
  });

  it('finds where the server makes each field: the response, and the aggregation', () => {
    const low = read('Stock health').fields.find((field) => field.field === 'lowStockCount')!;
    expect(low.made.map((entry) => entry.how)).toEqual(['returned', 'computed']);
    expect(low.made[0]!.code).toBe('lowStockCount: totals.lowStockCount');
    expect(low.made[1]!.code).toMatch(/^lowStockCount: \{ \$sum: \{ \$cond/);
    expect(low.made[1]!.file).toBe('lib/store.ts');
  });

  it('reads what decides what a card draws: a status, an empty list, the page waiting', () => {
    const health = read('Stock health').conditions;
    expect(health).toContainEqual(
      expect.objectContaining({ code: 'pct >= 70', outcomes: ['“Good”', '“Low”'], where: 'card' }),
    );
    expect(health).toContainEqual(
      expect.objectContaining({
        code: 'isLoading || !data',
        outcomes: ['Skeleton', 'the card'],
        where: 'around',
      }),
    );
    expect(read('Recent activity').conditions).toContainEqual(
      expect.objectContaining({
        code: 'data.recent.length === 0',
        outcomes: ['EmptyState “No activity yet”', 'a row per item'],
      }),
    );
  });

  it('reads a hook that returns its data itself, and tells its state apart', () => {
    const worth = read('Inventory worth');
    expect(worth.values.map((value) => [value.code, value.fields])).toEqual([
      ['formatNumber(stats.inventoryValue)', ['inventoryValue']],
    ]);
    expect(worth.sources.map((source) => [source.hook, source.fields])).toEqual(
      expect.arrayContaining([['useStats', ['inventoryValue']]]),
    );
  });

  it('reads a list row by row, field by field', () => {
    const fields = read('Recent activity').values.flatMap((value) => value.fields);
    expect(fields).toContain('recent[].reason');
  });

  it('reads a link in a list of tiles for the one tile it stands for', () => {
    const attention = card('Needs attention');
    const index = (attention.items ?? []).findIndex(
      (item) => 'link' in item && item.link.label === 'Low',
    );
    const item = attention.items![index]!;
    const link = 'link' in item ? item.link : undefined;
    const data = cardData(
      graph,
      flows,
      { file: attention.file!, line: attention.line! },
      { reader, pick: 'Low', element: { file: link!.file!, line: link!.line! } },
    )!;
    expect(data.values.map((value) => [value.code, value.fields, value.format])).toEqual([
      ['formatNumber(t.value)', ['lowStockCount'], ['formatNumber']],
    ]);
    expect(data.fields.map((field) => field.field)).toEqual(['lowStockCount']);
  });
});
