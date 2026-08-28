import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scan,
  composeTitle,
  eventVerb,
  humanizeName,
  pageRouteOf,
  resolveFlows,
  screenOf,
  stepTitle,
} from '@flowlens/core';
import { exampleScan } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Tile labels.
 *
 * `Submit` is not a feature name in an app with fifteen submits, so every user
 * action carries the part of the product it belongs to. These tests pin the
 * naming rules, because the failure mode is silent: a wrong-but-plausible
 * screen name is worse than none.
 */
describe('naming the screen a file belongs to', () => {
  it('names a pages-router screen after its route', () => {
    expect(screenOf('pages/prescription/[id].js', 'Prescription')).toEqual({
      screen: 'Prescription',
      page: '/prescription/[id]',
    });
  });

  it('reads the last two route segments, because half of them end in a verb', () => {
    expect(screenOf('pages/prescription/create.js', 'Create').screen).toBe('Prescription create');
  });

  it('treats index as the directory itself', () => {
    expect(screenOf('pages/billing/index.js', 'Billing')).toEqual({
      screen: 'Billing',
      page: '/billing',
    });
    expect(screenOf('pages/index.js', 'Home')).toEqual({ screen: 'Home', page: '/' });
  });

  it('does not repeat a route segment that already names its parent', () => {
    expect(screenOf('pages/billing/billing-list.js', 'BillingList').screen).toBe('Billing list');
  });

  it('handles the app router', () => {
    expect(screenOf('app/(dashboard)/invoices/page.tsx', 'Page').screen).toBe('Invoices');
  });

  it('leaves API routes to the backend analyzer', () => {
    expect(pageRouteOf('pages/api/patients.ts')).toBeUndefined();
    expect(pageRouteOf('app/api/patients/route.ts')).toBeUndefined();
    // Not a page at all.
    expect(pageRouteOf('components/TimeSlotPopup.js')).toBeUndefined();
  });

  it('names a component after its feature folder', () => {
    expect(screenOf('components/patient_detail/ActionButtons.js', 'ActionButtons')).toEqual({
      screen: 'Patient detail',
      area: 'patient_detail',
    });
  });

  it('looks past folders that group markup by size rather than by feature', () => {
    expect(screenOf('components/prescription/parts/RxFooter.js', 'RxFooter').screen).toBe(
      'Prescription',
    );
  });

  /**
   * `billing/components/Invoice.tsx` really is the billing screen, but that path
   * cannot be told apart from a multi-root scan's
   * `my-repo/components/Invoice.tsx` — where guessing would name every screen
   * after the repository. So the component name wins: less specific, never wrong.
   */
  it('prefers the component to a guess above the code root', () => {
    expect(screenOf('billing/components/Invoice.tsx', 'Invoice').screen).toBe('Invoice');
  });

  /**
   * The regression that made this worth testing: a multi-root scan prefixes
   * every path with the project folder, so walking *up* from the file named
   * every screen in the app after the repository.
   */
  it('never names a screen after the repository it was scanned from', () => {
    const place = screenOf('whatsapp-clinic-frontend-web/components/MyPatient.js', 'MyPatient');
    expect(place.screen).toBe('My patient');
    expect(place.area).toBeUndefined();
  });

  it('falls back to the component when no folder says anything', () => {
    expect(screenOf('web/src/components/PatientForm.tsx', 'PatientForm').screen).toBe(
      'Patient form',
    );
  });

  it('reads Windows paths', () => {
    expect(screenOf('components\\patient_detail\\Buttons.js', 'Buttons').screen).toBe(
      'Patient detail',
    );
  });
});

describe('humanizing a name', () => {
  it('sentence-cases a phrase', () => {
    expect(humanizeName('edit-appointment')).toBe('Edit appointment');
    expect(humanizeName('RxScreen')).toBe('Rx screen');
    expect(humanizeName('clinicSettings')).toBe('Clinic settings');
    expect(humanizeName('TimeSlotPopup.js')).toBe('Time slot popup');
  });

  it('keeps acronyms a developer would not lower-case', () => {
    expect(humanizeName('gmb_dashboard')).toBe('GMB dashboard');
    expect(humanizeName('abhaM1')).toBe('ABHA m1');
    expect(humanizeName('rxPatient')).toBe('Rx patient');
  });
});

describe('composing a tile title', () => {
  it('puts the screen in front of the action', () => {
    expect(composeTitle('Prescription', 'Submit')).toBe('Prescription · Submit');
  });

  it('accepts a separator, for terminals that cannot draw one', () => {
    expect(composeTitle('Prescription', 'Submit', ' - ')).toBe('Prescription - Submit');
  });

  it('does not repeat itself when the action already says where it is', () => {
    expect(composeTitle('Prescription form', 'Submit Prescription')).toBe('Submit Prescription');
    // `Patients` and `patient` are the same word for this purpose.
    expect(composeTitle('Patients', 'Add patient')).toBe('Add patient');
    expect(composeTitle('Prescription', 'Submit Prescription')).toBe('Submit Prescription');
  });

  it('is not fooled into deduping by a generic word', () => {
    expect(composeTitle('Prescription form', 'Save form')).toBe('Prescription form · Save form');
  });

  it('survives an empty half', () => {
    expect(composeTitle('', 'Submit')).toBe('Submit');
    expect(composeTitle('Prescription', '')).toBe('Prescription');
  });
});

describe('the gesture', () => {
  it('reads as a user would say it', () => {
    expect(eventVerb('onClick')).toBe('click');
    expect(eventVerb('onDoubleClick')).toBe('double click');
    expect(eventVerb('onSubmit')).toBe('submit');
    expect(eventVerb('mount')).toBe('loads');
  });
});

/**
 * A project shaped the way the naming rules care about: a route with a dynamic
 * segment that fetches on mount, and an icon with nothing to quote.
 */
describe('a screen that fetches on mount, and an icon with no label', () => {
  const fixture = () => scan({ root: resolve(here, 'fixtures', 'screens') });
  const actions = () =>
    fixture()
      .graph.nodesOfKind('ui-action')
      .map((node) => ({
        label: node.label,
        title: String(node.meta?.['title'] ?? ''),
        screen: String(node.meta?.['screen'] ?? ''),
        event: node.meta?.['event'],
        action: node.meta?.['action'],
      }));

  it('names the mount action after the screen and the component that fetches', () => {
    const mount = actions().find((action) => action.event === 'mount');
    expect(mount?.screen).toBe('Prescription');
    expect(mount?.title).toBe('Prescription screen loads');
  });

  it('names an unlabelled icon after its component and the gesture', () => {
    const icon = actions().find((action) => action.label.includes('onClick'));
    expect(icon?.title).toBe('Patient detail · Icon bar click');
    // There are no words on the element, so there are none to quote.
    expect(icon?.action).toBeUndefined();
  });

  it('still puts the screen in front of a labelled button', () => {
    const submit = actions().find((action) => action.label === 'Submit');
    expect(submit?.title).toBe('Prescription · Submit');
    expect(submit?.action).toBe('Submit');
  });
});

/**
 * Two screens, one endpoint. The api-call node is shared by design — that is
 * what answers "who else calls this?" — so each flow has to be told which call
 * site is its own.
 */
describe('an endpoint two screens call', () => {
  const flows = () =>
    resolveFlows(scan({ root: resolve(here, 'fixtures', 'shared-endpoint') }).graph, {
      includeLocalOnly: true,
    });

  const siteOf = (label: string) => {
    const flow = flows().find((candidate) => candidate.label === label);
    return flow?.steps.find((step) => step.kind === 'api-call');
  };

  it('shows each flow the call site it goes through, not the first one scanned', () => {
    expect(siteOf('Complete appointment')?.file).toBe(
      'components/patient_detail/CompleteButton.js',
    );
    expect(siteOf('Skip payment')?.file).toBe('components/RequestPaymentPopup.js');
  });

  it('says how many other places share the endpoint', () => {
    expect(siteOf('Complete appointment')?.meta?.['otherCallers']).toBe(1);
    expect(siteOf('Skip payment')?.meta?.['otherCallers']).toBe(1);
  });
});

describe('flows carry a descriptive title', () => {
  const flows = () => resolveFlows(exampleScan().graph, { includeLocalOnly: true });

  it('names a click on a page after the screen it is on', () => {
    const search = flows().find((flow) => flow.label === 'Search');
    expect(search?.screen).toBe('Patients');
    expect(search?.title).toBe('Patients · Search');
  });

  it('keeps the label the words on the element', () => {
    const flow = flows().find((flow) => flow.label === 'Delete');
    expect(flow?.title).toBe('Patients · Delete');
    expect(flow?.label).toBe('Delete');
  });

  it('does not stutter when the button text already names the screen', () => {
    const flow = flows().find((flow) => flow.label === 'Submit Prescription');
    expect(flow?.screen).toBe('Prescription form');
    expect(flow?.title).toBe('Submit Prescription');
  });

  it('shows the title on the user-action step and the identifier on code steps', () => {
    const flow = flows().find((candidate) => candidate.label === 'Search');
    const action = flow?.steps.find((step) => step.kind === 'ui-action');
    const handler = flow?.steps.find((step) => step.kind === 'handler');
    expect(action && stepTitle(action)).toBe('Patients · Search');
    expect(handler && stepTitle(handler)).toBe(handler?.label);
  });

  it('never leaves a React prop name in a title', () => {
    for (const flow of flows()) {
      expect(flow.title).not.toMatch(/on(Click|Submit|Press)/);
    }
  });
});
