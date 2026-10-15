import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appNavigation,
  appSidebar,
  isFieldEdit,
  normalizeRoute,
  resolveFlows,
  routeKey,
  scan,
  type SidebarEntry,
} from '@flowslens/core';

/**
 * Reading the app's own menu.
 *
 * The shape is the one a real Next.js clinic app uses: a side menu that maps
 * over `{ name, link: CONSTANT }` entries, and a settings entry whose
 * sub-entries pick a tab (`{ name, tab: 1 }`) on one settings page that pairs
 * tab ids with components.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-nav-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const page = (name: string, url: string) => `
  const ${name} = () => {
    useEffect(() => { axios.get("${url}"); }, []);
    return <div>${name}</div>;
  };
  export default ${name};`;

const clinic = project({
  'constant.js': `
    export const HOME = "home";
    export const BILLING = "billingList";
    export const SETTING = "setting";
    export const ROUTES = { services: "/clinicService" };`,
  'components/sideMenu.js': `
    import { HOME, BILLING, ROUTES } from "../constant";
    const SideMenu = () => {
      const doctorItems = [
        { name: "Home", link: HOME, icon: Home },
        { name: "Billing", link: BILLING, icon: Bill },
        {
          name: "Clinic Setting",
          icon: Setting,
          options: [
            { name: "Details", tab: 0 },
            { name: "Timing", tab: 1 },
          ],
        },
        { name: "Clinic Services", link: ROUTES.services },
      ];
      const columns = [{ name: "a" }, { name: "b" }, { name: "c" }];
      return <div>{doctorItems.map((item) => <a key={item.name}>{item.name}</a>)}</div>;
    };
    export default SideMenu;`,
  'components/settings/Details.js': `
    const Details = () => {
      const save = async () => { await axios.put("/api/clinic/details", {}); };
      return <button onClick={save}>Save details</button>;
    };
    export default Details;`,
  'components/settings/Timing.js': `
    const Timing = () => {
      const save = async () => { await axios.put("/api/clinic/timing", {}); };
      return <button onClick={save}>Save timing</button>;
    };
    export default Timing;`,
  'components/settings/Staff.js': `
    const Staff = () => <div>Staff</div>;
    export default Staff;`,
  'pages/setting/edit/[id].js': `
    import Details from "../../../components/settings/Details";
    import Timing from "../../../components/settings/Timing";
    import Staff from "../../../components/settings/Staff";
    const EditClinic = () => {
      const content = [
        { id: 0, component: <Details role="edit" /> },
        { id: 1, component: (<div className="box"><Timing /></div>) },
        { id: 3, component: <Staff /> },
      ];
      return <div>{content.map((c) => c.component)}</div>;
    };
    export default EditClinic;`,
  'pages/signup.js': page('Signup', '/api/signup'),
  'pages/login/index.js': `
    const Login = () => (
      <>
        <Head><title>Sign in || MyClinic</title></Head>
        <button onClick={() => axios.post("/api/login")}>Continue</button>
      </>
    );
    export default Login;`,
  'pages/login/[id].js': page('LoginStep', '/api/login/verify'),
  'pages/forgot-password.js': page('ForgotPassword', '/api/forgot'),
  'pages/home/index.js': page('Home', '/api/home'),
  'pages/billingList/index.js': page('BillingList', '/api/bills'),
  'pages/clinicService/index.js': page('ClinicService', '/api/services'),
});

describe('appNavigation', () => {
  const { graph } = scan({ root: clinic });
  const nav = appNavigation(graph);

  it('reads the menu array the side menu maps over, in its order', () => {
    expect(nav?.file).toBe('components/sideMenu.js');
    expect(nav?.items.map((item) => item.label)).toEqual([
      'Home',
      'Billing',
      'Clinic Setting',
      'Clinic Services',
    ]);
  });

  it('follows links through imported constants and object members', () => {
    const routes = Object.fromEntries(nav!.items.map((item) => [item.label, item.route]));
    expect(routes['Home']).toBe('/home');
    expect(routes['Billing']).toBe('/billingList');
    expect(routes['Clinic Services']).toBe('/clinicService');
  });

  it('matches tab entries to the component their tab shows, on the page that shows it', () => {
    const settings = nav!.items.find((item) => item.label === 'Clinic Setting')!;
    expect(settings.route).toBe('/setting/edit/[id]');
    expect(settings.children.map((child) => [child.label, child.component?.name])).toEqual([
      ['Details', 'Details'],
      ['Timing', 'Timing'],
    ]);
    expect(settings.children[1]?.component?.file).toBe('components/settings/Timing.js');
  });

  it('adds the sign-in pages no menu links to, in the order a new user meets them', () => {
    expect(nav!.auth.map((item) => [item.label, item.route])).toEqual([
      ['Sign in', '/login'],
      ['Login › Details', '/login/[id]'],
      ['Signup', '/signup'],
      ['Forgot password', '/forgot-password'],
    ]);
  });

  it('finds no menu in an app that does not write one down', () => {
    const plain = project({ 'pages/index.js': page('Index', '/api/x') });
    expect(appNavigation(scan({ root: plain }).graph)).toBeUndefined();
  });
});

describe('route spelling', () => {
  it('reads a link the way a page file names its route', () => {
    expect(normalizeRoute('home')).toBe('/home');
    expect(normalizeRoute('/billing/?tab=2')).toBe('/billing');
    expect(normalizeRoute('/patients/:id')).toBe('/patients/[id]');
    expect(routeKey('/setting/edit/[param]')).toBe(routeKey('/setting/edit/[id]'));
  });
});

describe('appSidebar', () => {
  const app = project({
    'constant.js': `
      export const HOME = "home";
      export const ORDERS = "orders";
      export const PATIENT = "patient";`,
    'components/Layout.js': `
      import SideMenu from "./SideMenu";
      const Layout = ({ children }) => <div><SideMenu />{children}</div>;
      export default Layout;`,
    'components/SideMenu.js': `
      import { HOME, ORDERS } from "../constant";
      import WalkIn from "./WalkIn";
      const SideMenu = () => {
        const items = [
          { name: "Home", link: HOME },
          { name: "Orders", link: ORDERS },
          { name: "Reports", link: "/reports" },
        ];
        const add = async () => { await axios.post("/api/walkin/start"); };
        return (
          <nav>
            <button onClick={add}>Add Walk-In</button>
            <WalkIn />
            {items.map((item) => <a key={item.name}>{item.name}</a>)}
          </nav>
        );
      };
      export default SideMenu;`,
    'components/WalkIn.js': `
      const WalkIn = () => {
        const save = async () => { await axios.post("/api/walkin"); };
        return <button onClick={save}>Save walk-in</button>;
      };
      export default WalkIn;`,
    'components/Stats.js': `
      const Stats = () => {
        const download = async () => { await axios.get("/api/stats/download"); };
        return <button onClick={download}>Download</button>;
      };
      export default Stats;`,
    'components/PatientRow.js': `
      import { PATIENT } from "../constant";
      const PatientRow = () => {
        const router = useRouter();
        // A request to the API, not a link to the /orders screen.
        const ping = async () => { await axios.get("/orders/count"); };
        return <div onClick={() => router.push(
          \`/\${PATIENT}/\${id}\`
        )}>Open</div>;
      };
      export default PatientRow;`,
    'pages/home/index.js': `
      import Layout from "../../components/Layout";
      import Stats from "../../components/Stats";
      import PatientRow from "../../components/PatientRow";
      const Home = () => {
        useEffect(() => { axios.get("/api/home"); }, []);
        const refresh = async () => { await axios.get("/api/home/refresh"); };
        const help = async () => { await axios.get("/api/help"); };
        return (
          <Layout>
            <button onClick={refresh}>Refresh</button>
            <Stats />
            <button onClick={help}>Help</button>
            <input placeholder="Search patients" onChange={(e) => setQuery(e.target.value)} />
            <PatientRow />
          </Layout>
        );
      };
      export default Home;`,
    'pages/orders/index.js': `
      import Layout from "../../components/Layout";
      const Orders = () => {
        useEffect(() => { axios.get("/api/orders"); }, []);
        return <Layout><a href="/orders/new">New</a></Layout>;
      };
      export default Orders;`,
    'pages/orders/[id].js': page('OrderDetail', '/api/orders/1'),
    'pages/patient/[id].js': page('PatientDetail', '/api/patients/1'),
    'pages/reports.js': page('Reports', '/api/reports'),
    'pages/legacy.js': page('Legacy', '/api/legacy'),
    'pages/login.js': page('Login', '/api/login'),
  });
  const { graph } = scan({ root: app });
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const sidebar = appSidebar(graph, flows)!;
  const title = (id: string) => flows.find((flow) => flow.id === id)?.title;
  const find = (label: string, entries = sidebar.entries): SidebarEntry | undefined => {
    for (const entry of entries) {
      if (entry.label === label) return entry;
      const found = find(label, entry.children);
      if (found) return found;
    }
    return undefined;
  };

  it("copies the menu, with sign-in pages above and the menu's own buttons as rows", () => {
    expect(sidebar.entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ['auth', 'Login'],
      ['sidebar', 'Menu'],
      ['sidebar', 'Walk in'],
      ['menu', 'Home'],
      ['menu', 'Orders'],
      ['menu', 'Reports'],
      ['other', 'Other screens'],
    ]);
    const menu = sidebar.entries[1]!;
    expect(menu.flat).toBe(true);
    expect(menu.actions.map(title)).toEqual(['Side menu · Add Walk-In']);
  });

  it("lists a screen's actions as the screen has them: loads first, then top to bottom", () => {
    expect(find('Home')!.actions.map(title)).toEqual([
      'Home loads',
      'Home · Refresh',
      // Drawn by <Stats /> between the two buttons, so it sits between them.
      'Stats · Download',
      'Home · Help',
      // A click that only navigates is an action; typing in the search box is not.
      'Patient row · Open',
    ]);
  });

  it('nests the screens an entry leads to: by route, and by the links on it', () => {
    const orders = find('Orders')!;
    expect(orders.children.map((child) => child.route)).toEqual(['/orders/[id]']);
    // `router.push(\`/${PATIENT}/${id}\`)` on Home, through a constant.
    expect(find('Home')!.children.map((child) => child.route)).toEqual(['/patient/[id]']);
  });

  it('keeps only screens nothing links to for the bottom, and places every action', () => {
    expect(find('Other screens')!.children.map((child) => child.route)).toEqual(['/legacy']);
    const placed = new Set<string>();
    const walk = (entries: SidebarEntry[]) => {
      for (const entry of entries) {
        entry.actions.forEach((id: string) => placed.add(id));
        walk(entry.children);
      }
    };
    walk(sidebar.entries);
    // Every action but typing in a field, which is filling a form in.
    const unplaced = flows.filter((flow) => !placed.has(flow.id));
    expect(unplaced.length).toBe(1);
    expect(unplaced.every(isFieldEdit)).toBe(true);
  });
});
