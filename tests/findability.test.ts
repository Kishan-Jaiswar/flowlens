import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowPages, pageTitle, resolveFlows, scan } from '@flowslens/core';

/**
 * Finding an action in the list.
 *
 * Each case here is a shape from a real Next.js app whose most important
 * button — "Add Walk-In Appointment" — was missing from the sidebar, named
 * after a different button, or filed under no page at all.
 */

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-find-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

const walkIn = project({
  'components/walkIn/WalkInForm.js': `
    import { useForm } from "react-hook-form";
    import { PrimaryButton } from "../PrimaryButton";
    const WalkInForm = () => {
      const { handleSubmit } = useForm();
      const [busy, setBusy] = useState(false);
      const handleAddWalkIn = async (data) => {
        await axios.post("/api/appointments/walkin", data);
      };
      return (
        <form onSubmit={handleSubmit(handleAddWalkIn)}>
          <button type="button" onClick={() => setBusy(true)}>Add Relative</button>
          <PrimaryButton type="submit">
            {busy ? <span>Adding...</span> : <p>{"Add Walk-In Appointment"}</p>}
          </PrimaryButton>
        </form>
      );
    };
    export default WalkInForm;`,
  'components/EditPatient.js': `
    const EditPatient = () => {
      const save = async () => { await axios.put("/api/patients/1", {}); };
      return (
        <div>
          <form id="editPatientForm" onSubmit={form.handleSubmit(save)}><input name="first" /></form>
          <footer>
            <button type="submit" form="editPatientForm">{saving ? "Saving..." : \`Save \${count} details\`}</button>
          </footer>
        </div>
      );
    };
    export default EditPatient;`,
  'components/Archive.js': `
    const Archive = () => {
      const cancelAppointmentsAndArchive = async () => { await axios.post("/api/archive"); };
      return <button type="button" onClick={cancelAppointmentsAndArchive}>{loading ? "Cancelling..." : count}</button>;
    };
    export default Archive;`,
  'pages/medication/index.js': `
    const Index = () => {
      useEffect(() => { axios.get("/api/medications"); }, []);
      return <div />;
    };
    export default Index;`,
  'components/TimeSlotPopup.js': `
    export const TimeSlotPopup = () => {
      useEffect(() => { axios.get("/api/slots"); }, []);
      return <div />;
    };`,
  'components/TimeSlotPopupNew.js': `
    export const TimeSlotPopup = () => {
      useEffect(() => { axios.get("/api/slots/v2"); }, []);
      return <div />;
    };`,
});

const walkInFlows = resolveFlows(scan({ root: walkIn }).graph, { includeLocalOnly: true });
const titled = (title: string) => walkInFlows.find((flow) => flow.title === title);

describe('a form submitted through handleSubmit(fn)', () => {
  it('follows the wrapper to the function it validates for', () => {
    const flow = walkInFlows.find(
      (candidate) => candidate.event === 'onSubmit' && candidate.component === 'WalkInForm',
    );
    expect(flow?.endpoints).toEqual(['POST /appointments/walkin']);
    expect(flow?.hitsBackend).toBe(true);
  });

  it('follows form.handleSubmit(fn) too', () => {
    const flow = walkInFlows.find((candidate) => candidate.component === 'EditPatient');
    expect(flow?.endpoints).toEqual(['PUT /patients/:param']);
  });
});

describe('naming a form after the button that submits it', () => {
  it('takes the type="submit" button, of any component, over a type="button" one', () => {
    expect(titled('Add Walk-In Appointment')).toBeDefined();
    expect(
      walkInFlows.some((flow) => flow.title.includes('Add Relative') && flow.event === 'onSubmit'),
    ).toBe(false);
  });

  it('finds a submit button outside the form by its form="id"', () => {
    const flow = walkInFlows.find((candidate) => candidate.component === 'EditPatient');
    expect(flow?.label).toBe('Save details');
  });

  it('never names a button after its busy text, falling back to the handler', () => {
    expect(walkInFlows.some((flow) => /(?:\.\.\.|…)/.test(flow.title))).toBe(false);
    const flow = walkInFlows.find((candidate) => candidate.component === 'Archive');
    expect(flow?.label).toBe('Cancel Appointments And Archive');
  });
});

describe('titles that say where the action is', () => {
  it('names a page component called Index after its screen', () => {
    expect(titled('Medication loads')).toBeDefined();
    expect(walkInFlows.some((flow) => flow.title.includes('Index'))).toBe(false);
  });

  it('tells two same-named components apart by their file name, not the whole path', () => {
    const titles = walkInFlows
      .filter((flow) => flow.component === 'TimeSlotPopup')
      .map((flow) => flow.title)
      .sort();
    expect(titles).toEqual([
      'Time slot popup loads (Time slot popup new)',
      'Time slot popup loads (Time slot popup)',
    ]);
  });
});

describe('placing an action on its page', () => {
  const root = project({
    'components/medication/StockMedications.js': `
      const MappingCell = () => (
        <button onClick={() => axios.delete("/api/stock/mapping")}>Clear mapping</button>
      );
      export default function StockMedications() {
        return <table><tbody><tr><td><MappingCell /></td></tr></tbody></table>;
      }`,
    'pages/medication/index.js': `
      import StockMedications from "../../components/medication/StockMedications";
      export default function Index() { return <StockMedications />; }`,
    'components/material/MaterialLibraryPreview.js': `
      const MaterialPreview = () => (
        <button onClick={() => axios.post("/api/materials/share")}>Share material</button>
      );
      export default MaterialPreview;`,
    'pages/material/index.js': `
      import MaterialLibraryPreview from "@/components/material/MaterialLibraryPreview";
      import Head from "next/head";
      export default function Materials() {
        return <><Head><title>Material Library || MyClinic</title></Head><MaterialLibraryPreview /></>;
      }`,
  });
  const { graph } = scan({ root });
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const pages = flowPages(graph, flows);
  const pagesOf = (label: string) =>
    pages.get(flows.find((flow) => flow.label === label)!.id) ?? [];

  it('reaches a component only its own file renders, through that file', () => {
    expect(pagesOf('Clear mapping').map((page) => page.route)).toEqual(['/medication']);
  });

  it('follows a default import renamed at the import', () => {
    expect(pagesOf('Share material').map((page) => page.route)).toEqual(['/material']);
  });

  it('carries the title the browser tab shows', () => {
    expect(pagesOf('Share material')[0]?.title).toBe('Material Library');
    expect(pagesOf('Clear mapping')[0]?.title).toBeUndefined();
  });
});

describe('pageTitle', () => {
  it('cuts the site name after a separator', () => {
    expect(pageTitle('<title>Bills || MyClinic</title>')).toBe('Bills');
    expect(pageTitle('<title>Orders | Shop</title>')).toBe('Orders');
    expect(pageTitle('<title>{"Chats — MyClinic"}</title>')).toBe('Chats');
  });

  it('reads App Router metadata', () => {
    expect(pageTitle('export const metadata = { title: "Invoices · Acme" };')).toBe('Invoices');
  });

  it('skips a title built from data', () => {
    expect(pageTitle('<title>{patient.name}</title>')).toBeUndefined();
    expect(pageTitle('<div />')).toBeUndefined();
  });
});
