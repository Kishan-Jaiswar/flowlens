import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appSidebar,
  resolveFlows,
  scan,
  scopeSummary,
  screenOutline,
  SourceReader,
  type OutlineNode,
  type SidebarEntry,
} from '@flowslens/core';

/**
 * A screen read top to bottom: the shape is a pharmacy dashboard — stat cards
 * with a title prop, cards with a `<CardTitle>`, a card of links mapped from
 * an array, a card component that loads its own data, and a dialog whose
 * footer is built in a variable before it is returned.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-outline-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const app = project({
  'components/SideMenu.js': `
    const SideMenu = () => {
      const items = [
        { name: "Dashboard", link: "/dashboard" },
        { name: "Medicines", link: "/medicines" },
        { name: "Stock", link: "/stock" },
      ];
      return <nav>{items.map((item) => <a key={item.name}>{item.name}</a>)}</nav>;
    };
    export default SideMenu;`,
  'components/StatCard.js': `
    const StatCard = ({ title, footer }) => <div><h3>{title}</h3>{footer}</div>;
    export default StatCard;`,
  'components/AttentionCard.js': `
    import StatCard from "./StatCard";
    const AttentionCard = () => {
      const tiles = [
        { href: "/medicines?filter=low", label: "Low" },
        { href: "/medicines?filter=out", label: "Stockout" },
      ];
      return (
        <StatCard
          title="Needs attention"
          footer={<div>{tiles.map((t) => <Link key={t.label} href={t.href}>{t.label}</Link>)}</div>}
        />
      );
    };
    export default AttentionCard;`,
  'components/ExpiringCard.js': `
    const ExpiringCard = () => {
      useEffect(() => { axios.get("/api/expiring"); }, []);
      return (
        <Card>
          <CardTitle>Expiring soon</CardTitle>
          <Link href="/medicines?expiring=true">View all</Link>
          {rows.map((m) => <Link key={m.id} href={\`/medicines/\${m.id}\`}>Open</Link>)}
        </Card>
      );
    };
    export default ExpiringCard;`,
  'components/ImportDialog.js': `
    const ImportDialog = () => {
      const run = async () => { await axios.post("/api/import"); };
      const footer = <button onClick={run}>Import</button>;
      return <Dialog title="Import inventory" footer={footer}><p>Pick a file</p></Dialog>;
    };
    export default ImportDialog;`,
  'pages/dashboard.js': `
    import StatCard from "../components/StatCard";
    import AttentionCard from "../components/AttentionCard";
    import ExpiringCard from "../components/ExpiringCard";
    import ImportDialog from "../components/ImportDialog";
    export default function Dashboard() {
      useEffect(() => { axios.get("/api/dashboard"); }, []);
      const refresh = async () => { await axios.get("/api/dashboard/refresh"); };
      return (
        <div>
          <button onClick={refresh}>Refresh</button>
          <StatCard title="Stock health" />
          <AttentionCard />
          <Card>
            <CardTitle>Recent activity</CardTitle>
            <Link href="/stock">View all</Link>
          </Card>
          <ExpiringCard />
          <ImportDialog />
        </div>
      );
    }`,
  'pages/medicines/index.js': `
    export default function Medicines() {
      useEffect(() => { axios.get("/api/medicines"); }, []);
      return <div>Medicines</div>;
    }`,
  'pages/medicines/[id].js': `
    export default function Medicine() {
      useEffect(() => { axios.get("/api/medicines/1"); }, []);
      return <div>Medicine</div>;
    }`,
  'pages/stock.js': `
    export default function Stock() {
      useEffect(() => { axios.get("/api/stock"); }, []);
      return <div>Stock</div>;
    }`,
});

const { graph } = scan({ root: app });

/** The outline as lines: `▸ card`, `→ label href`, `• handler`. */
function lines(nodes: OutlineNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const pad = '  '.repeat(depth);
    if (node.type === 'section')
      return [`${pad}▸ ${node.label}`, ...lines(node.children, depth + 1)];
    if (node.type === 'link') {
      return [`${pad}→ ${node.label ?? ''} ${node.href}${node.repeated ? ' (each)' : ''}`];
    }
    if (node.type === 'handler') return [`${pad}• ${node.file}`];
    return [];
  });
}

describe('screenOutline', () => {
  const outline = lines(screenOutline(new SourceReader(graph), 'pages/dashboard.js'));

  it('reads the cards of a screen in the order they are drawn, by the title they show', () => {
    expect(outline.filter((line) => line.startsWith('▸'))).toEqual([
      '▸ Stock health',
      '▸ Needs attention',
      '▸ Recent activity',
      '▸ Expiring soon',
      '▸ Import inventory',
    ]);
  });

  it('spells out links mapped from an array, and marks a list drawn from data as each row', () => {
    expect(outline).toContain('  → Low /medicines?filter=low');
    expect(outline).toContain('  → Stockout /medicines?filter=out');
    expect(outline).toContain('  → View all /stock');
    expect(outline).toContain('  → Open /medicines/[param] (each)');
  });

  it('puts what a dialog builds before returning it inside the dialog', () => {
    const at = outline.indexOf('▸ Import inventory');
    expect(outline[at + 1]).toBe('  • components/ImportDialog.js');
  });
});

describe('appSidebar lays a screen out as its outline', () => {
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const sidebar = appSidebar(graph, flows)!;
  const dashboard = sidebar.entries.find((entry) => entry.label === 'Dashboard')!;
  const title = (id: string) => flows.find((flow) => flow.id === id)?.title;
  const child = (label: string): SidebarEntry =>
    dashboard.children.find((entry) => entry.label === label)!;

  it('lists the page load, its controls and its cards, top to bottom', () => {
    const items = (dashboard.items ?? []).map((item) =>
      'action' in item
        ? title(item.action)
        : 'section' in item
          ? `▸ ${dashboard.children.find((entry) => entry.key === item.section)?.label}`
          : `→ ${item.link.href}`,
    );
    expect(items).toEqual([
      'Dashboard loads',
      'Dashboard · Refresh',
      '▸ Stock health',
      '▸ Needs attention',
      '▸ Recent activity',
      '▸ Expiring soon',
      '▸ Import inventory',
    ]);
  });

  it("puts each card's loads, actions and links inside the card", () => {
    expect(child('Expiring soon').kind).toBe('section');
    expect(child('Expiring soon').actions.map(title)).toEqual(['Expiring card loads']);
    expect(
      child('Needs attention').items?.map((item) => ('link' in item ? item.link.label : '')),
    ).toEqual(['Low', 'Stockout']);
    expect(child('Import inventory').actions.map(title)).toEqual(['Import dialog · Import']);
  });
});

describe('scopeSummary', () => {
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const sidebar = appSidebar(graph, flows)!;
  const dashboard = sidebar.entries.find((entry) => entry.label === 'Dashboard')!;
  const ids = (entry: SidebarEntry): string[] => [
    ...entry.actions,
    ...entry.children.filter((child) => child.kind === 'section').flatMap(ids),
  ];
  const summary = scopeSummary(graph, flows, ids(dashboard));

  it('sums a page up from every action on it, its cards included', () => {
    expect(summary.actions.map((action) => action.title)).toEqual([
      'Dashboard loads',
      'Dashboard · Refresh',
      'Expiring card loads',
      'Import dialog · Import',
    ]);
    expect(summary.endpoints).toEqual([
      'GET /dashboard',
      'GET /dashboard/refresh',
      'GET /expiring',
      'POST /import',
    ]);
  });

  it('keeps each action’s own answers, so the page’s tabs can list them', () => {
    for (const action of summary.actions) {
      expect(action.timing.observed).toBe(false);
      expect(action.tests.totalCases).toBe(0);
    }
    expect(summary.files).toContain('pages/dashboard.js');
  });
});
