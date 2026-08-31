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
    expect(screenOf('pages/order/[id].js', 'Order')).toEqual({
      screen: 'Order',
      page: '/order/[id]',
    });
  });

  it('reads the last two route segments, because half of them end in a verb', () => {
    expect(screenOf('pages/order/create.js', 'Create').screen).toBe('Order create');
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
    expect(pageRouteOf('pages/api/customers.ts')).toBeUndefined();
    expect(pageRouteOf('app/api/customers/route.ts')).toBeUndefined();
    // Not a page at all.
    expect(pageRouteOf('components/TimeSlotPopup.js')).toBeUndefined();
  });

  it('names a component after its feature folder', () => {
    expect(screenOf('components/customer_detail/ActionButtons.js', 'ActionButtons')).toEqual({
      screen: 'Customer detail',
      area: 'customer_detail',
    });
  });

  it('looks past folders that group markup by size rather than by feature', () => {
    expect(screenOf('components/order/parts/RxFooter.js', 'RxFooter').screen).toBe('Order');
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
    const place = screenOf('shop-frontend-web/components/MyCustomer.js', 'MyCustomer');
    expect(place.screen).toBe('My customer');
    expect(place.area).toBeUndefined();
  });

  it('falls back to the component when no folder says anything', () => {
    expect(screenOf('web/src/components/CustomerForm.tsx', 'CustomerForm').screen).toBe(
      'Customer form',
    );
  });

  it('reads Windows paths', () => {
    expect(screenOf('components\\customer_detail\\Buttons.js', 'Buttons').screen).toBe(
      'Customer detail',
    );
  });
});

describe('humanizing a name', () => {
  it('sentence-cases a phrase', () => {
    expect(humanizeName('edit-shipment')).toBe('Edit shipment');
    expect(humanizeName('SkuScreen')).toBe('SKU screen');
    expect(humanizeName('shopSettings')).toBe('Shop settings');
    expect(humanizeName('TimeSlotPopup.js')).toBe('Time slot popup');
  });

  it('keeps acronyms a developer would not lower-case', () => {
    expect(humanizeName('seo_dashboard')).toBe('SEO dashboard');
    expect(humanizeName('crmM1')).toBe('CRM m1');
    expect(humanizeName('skuCustomer')).toBe('SKU customer');
  });
});

describe('composing a tile title', () => {
  it('puts the screen in front of the action', () => {
    expect(composeTitle('Order', 'Submit')).toBe('Order · Submit');
  });

  it('accepts a separator, for terminals that cannot draw one', () => {
    expect(composeTitle('Order', 'Submit', ' - ')).toBe('Order - Submit');
  });

  it('does not repeat itself when the action already says where it is', () => {
    expect(composeTitle('Order form', 'Submit Order')).toBe('Submit Order');
    // `Customers` and `customer` are the same word for this purpose.
    expect(composeTitle('Customers', 'Add customer')).toBe('Add customer');
    expect(composeTitle('Order', 'Submit Order')).toBe('Submit Order');
  });

  it('is not fooled into deduping by a generic word', () => {
    expect(composeTitle('Order form', 'Save form')).toBe('Order form · Save form');
  });

  it('survives an empty half', () => {
    expect(composeTitle('', 'Submit')).toBe('Submit');
    expect(composeTitle('Order', '')).toBe('Order');
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
    expect(mount?.screen).toBe('Order');
    expect(mount?.title).toBe('Order screen loads');
  });

  it('names an unlabelled icon after its component and the gesture', () => {
    const icon = actions().find((action) => action.label.includes('onClick'));
    expect(icon?.title).toBe('Customer detail · Icon bar click');
    // There are no words on the element, so there are none to quote.
    expect(icon?.action).toBeUndefined();
  });

  it('still puts the screen in front of a labelled button', () => {
    const submit = actions().find((action) => action.label === 'Submit');
    expect(submit?.title).toBe('Order · Submit');
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
    expect(siteOf('Complete shipment')?.file).toBe('components/customer_detail/CompleteButton.js');
    expect(siteOf('Skip payment')?.file).toBe('components/RequestPaymentPopup.js');
  });

  it('says how many other places share the endpoint', () => {
    expect(siteOf('Complete shipment')?.meta?.['otherCallers']).toBe(1);
    expect(siteOf('Skip payment')?.meta?.['otherCallers']).toBe(1);
  });
});

describe('flows carry a descriptive title', () => {
  const flows = () => resolveFlows(exampleScan().graph, { includeLocalOnly: true });

  it('names a click on a page after the screen it is on', () => {
    const search = flows().find((flow) => flow.label === 'Search');
    expect(search?.screen).toBe('Customers');
    expect(search?.title).toBe('Customers · Search');
  });

  it('keeps the label the words on the element', () => {
    const flow = flows().find((flow) => flow.label === 'Delete');
    expect(flow?.title).toBe('Customers · Delete');
    expect(flow?.label).toBe('Delete');
  });

  it('does not stutter when the button text already names the screen', () => {
    const flow = flows().find((flow) => flow.label === 'Submit Order');
    expect(flow?.screen).toBe('Order form');
    expect(flow?.title).toBe('Submit Order');
  });

  it('shows the title on the user-action step and the identifier on code steps', () => {
    const flow = flows().find((candidate) => candidate.label === 'Search');
    const action = flow?.steps.find((step) => step.kind === 'ui-action');
    const handler = flow?.steps.find((step) => step.kind === 'handler');
    expect(action && stepTitle(action)).toBe('Customers · Search');
    expect(handler && stepTitle(handler)).toBe(handler?.label);
  });

  it('never leaves a React prop name in a title', () => {
    for (const flow of flows()) {
      expect(flow.title).not.toMatch(/on(Click|Submit|Press)/);
    }
  });
});
