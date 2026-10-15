import { describe, expect, it } from 'vitest';
import {
  factorSharedDecisions,
  indexSharedDecisions,
  renderDecisionTree,
  sharedPartTree,
  type ActionDecisions,
  type DecisionGroup,
  type DecisionNode,
  type DecisionStep,
} from '../packages/core/src/index.js';

/**
 * Shared parts of decision trees: a helper drawn the same way in several
 * actions is told once, and each action names it with the ways it can end
 * there. What is worth pinning is that nothing is lost or made up on the way.
 */

const at = (file: string, line: number) => ({ file, line });

/** `requireClinic(request)`: two error returns, a catch, a success value. */
function requireClinic(line: number): DecisionGroup {
  return {
    type: 'group',
    kind: 'function',
    label: 'Run require clinic',
    title: 'requireClinic(request)',
    side: 'server',
    at: at(`app/api/route${line}.ts`, line),
    callee: at('lib/api/server.ts', 24),
    nodes: [
      {
        type: 'decision',
        question: 'user?',
        label: 'Has user?',
        code: 'user',
        side: 'server',
        at: at('lib/api/server.ts', 28),
        branches: [
          {
            label: 'no',
            ends: true,
            nodes: [
              {
                type: 'end',
                outcome: 'return',
                label: 'Return a 401 error to the caller · Unauthorized',
                text: 'returns { error: unauthorized() }',
                statuses: [401],
                side: 'server',
                at: at('lib/api/server.ts', 28),
              },
            ],
          },
        ],
        otherwise: 'yes',
      },
      {
        type: 'try',
        side: 'server',
        nodes: [
          {
            type: 'group',
            kind: 'function',
            label: 'Run has clinic access',
            title: 'hasClinicAccess(user.phone, clinicId)',
            side: 'server',
            at: at('lib/api/server.ts', 38),
            callee: at('lib/db/clinics.ts', 102),
            nodes: [
              {
                type: 'end',
                outcome: 'return',
                label: 'Return false',
                text: 'returns false',
                side: 'server',
              },
              {
                type: 'end',
                outcome: 'throw',
                label: 'Throw an error',
                text: 'throws new Error("db down")',
                side: 'server',
              },
            ],
          },
        ],
        catch: {
          label: 'anything above fails',
          ends: true,
          nodes: [
            {
              type: 'end',
              outcome: 'return',
              label: 'Return a 503 error to the caller · Try again',
              text: 'returns { error: misconfigured() }',
              statuses: [503],
              side: 'server',
            },
          ],
        },
      },
      {
        type: 'end',
        outcome: 'return',
        label: 'Return { user, clinicId }',
        text: 'returns { user, clinicId }',
        side: 'server',
      },
    ],
  };
}

function request(id: string, own: DecisionNode[]): ActionDecisions {
  const nodes: DecisionNode[] = [
    { type: 'step', kind: 'trigger', label: 'Opens', text: 'opens', side: 'browser' },
    {
      type: 'group',
      kind: 'request',
      label: 'Send GET /x',
      title: 'GET /x',
      side: 'server',
      nodes: own,
    },
  ];
  return {
    flowId: id,
    title: id,
    nodes,
    counts: { decisions: 0, outcomes: 0, queries: 0, requests: 1 },
    limits: [],
  };
}

const steps = (nodes: DecisionNode[]): DecisionNode[] =>
  nodes.flatMap((node) => [
    node,
    ...(node.type === 'group' ? steps(node.nodes) : []),
    ...(node.type === 'decision' ? node.branches.flatMap((branch) => steps(branch.nodes)) : []),
    ...(node.type === 'try'
      ? [...steps(node.nodes), ...(node.catch ? steps(node.catch.nodes) : [])]
      : []),
  ]);

const sharedSteps = (tree: ActionDecisions): DecisionStep[] =>
  steps(tree.nodes).filter(
    (node): node is DecisionStep => node.type === 'step' && node.kind === 'shared',
  );

describe('shared decisions', () => {
  const a = request('a', [requireClinic(6)]);
  const b = request('b', [requireClinic(9)]);
  const index = indexSharedDecisions([a, b]);

  it('shares a helper drawn the same way in two actions, wherever it is called from', () => {
    const titles = [...index.parts.values()].map((part) => part.title);
    expect(titles).toContain('requireClinic(request)');
    const part = [...index.parts.values()].find((p) => p.title === 'requireClinic(request)')!;
    expect(part.flows.sort()).toEqual(['a', 'b']);
  });

  it('names the outermost shared helper with one step, and every way it hands control back', () => {
    const factored = factorSharedDecisions(a, index);
    const [step] = sharedSteps(factored);
    expect(step!.text).toBe('requireClinic(request)');
    expect(step!.at).toEqual(at('app/api/route6.ts', 6));
    expect(step!.shared!.actions).toBe(2);
    // The throw inside the try is caught there; the helper's own `return false`
    // goes back to requireClinic, not to the action.
    expect(step!.shared!.ends).toEqual([
      { label: 'Return a 401 error to the caller · Unauthorized', statuses: [401] },
      { label: 'Return a 503 error to the caller · Try again', statuses: [503] },
      { label: 'Return { user, clinicId }' },
    ]);
    // Nothing of its inside is left in the action's tree.
    expect(steps(factored.nodes).some((node) => node.type === 'decision')).toBe(false);
    expect(factored.shared).toEqual([step!.shared!.id]);
  });

  it('draws the part on its own exactly as the helper is written', () => {
    const part = index.parts.get(factorSharedDecisions(a, index).shared[0]!)!;
    const tree = sharedPartTree(part);
    expect(tree.nodes).toHaveLength(1);
    const text = renderDecisionTree(tree);
    expect(text).toContain('▸ requireClinic(request)  (lib/api/server.ts:24)');
    expect(text).toContain('◆ user?');
    expect(text).toContain('hasClinicAccess(user.phone, clinicId)');
  });

  it('does not share a helper only one action runs, even twice', () => {
    const c = request('c', [requireClinic(6), requireClinic(7)]);
    const alone = indexSharedDecisions([c]);
    expect(alone.parts.size).toBe(0);
    // The second call is named, as the walk names it.
    const factored = factorSharedDecisions(c, alone);
    expect(renderDecisionTree(factored)).toContain('requireClinic(request) — opened above');
  });

  it('does not share helpers whose inside differs anywhere', () => {
    const other = requireClinic(6);
    (other.nodes[2] as { label: string }).label = 'Return { user }';
    const index2 = indexSharedDecisions([a, request('d', [other])]);
    expect([...index2.parts.values()].map((part) => part.title)).not.toContain(
      'requireClinic(request)',
    );
  });

  it('puts back a helper named "opened above" before comparing, so the name points at something', () => {
    // In `e` the helper ran earlier, so the walk only names it the second time.
    const named: DecisionStep = {
      type: 'step',
      kind: 'call',
      label: 'Run require clinic (opened above)',
      text: 'requireClinic(request) — opened above',
      side: 'server',
      at: at('app/api/route12.ts', 12),
    };
    const e = request('e', [requireClinic(11), named]);
    const factored = factorSharedDecisions(e, indexSharedDecisions([a, e]));
    const shared = sharedSteps(factored);
    expect(shared).toHaveLength(2);
    expect(shared[1]!.at).toEqual(at('app/api/route12.ts', 12));
    expect(renderDecisionTree(factored)).not.toContain('opened above');
  });

  it('says a throw is a 500 only where nothing around the call catches it', () => {
    const throwing = (line: number): DecisionGroup => ({
      type: 'group',
      kind: 'function',
      label: 'Run get db',
      title: 'getDb()',
      side: 'server',
      at: at('lib/store.ts', line),
      callee: at('lib/mongo.ts', 5),
      nodes: [
        {
          type: 'end',
          outcome: 'throw',
          label: 'Throw an error — not caught, so the server answers 500',
          text: 'throws new Error("no uri") — not caught, so the server answers 500',
          statuses: [500],
          uncaught: { text: 'throws new Error("no uri")', label: 'Throw an error' },
          side: 'server',
        },
      ],
    });
    const bare = request('bare', [throwing(1)]);
    const caught = request('caught', [
      {
        type: 'try',
        side: 'server',
        nodes: [throwing(2)],
        catch: {
          label: 'anything above fails',
          ends: true,
          nodes: [
            {
              type: 'end',
              outcome: 'respond',
              label: 'Respond 503',
              text: 'responds 503',
              statuses: [503],
              side: 'server',
            },
          ],
        },
      },
    ]);
    const shared = indexSharedDecisions([bare, caught]);
    // One part: the helper is the same; only what its throw means differs.
    expect([...shared.parts.values()].filter((part) => part.title === 'getDb()')).toHaveLength(1);
    const part = [...shared.parts.values()].find((p) => p.title === 'getDb()')!;
    expect(renderDecisionTree(sharedPartTree(part))).not.toContain('500');
    const [inBare] = sharedSteps(factorSharedDecisions(bare, shared));
    expect(inBare!.shared!.ends).toEqual([
      {
        label: 'Stop with an error — nothing catches it, so the server answers 500',
        statuses: [500],
      },
    ]);
    const [inCaught] = sharedSteps(factorSharedDecisions(caught, shared));
    expect(inCaught!.shared!.ends).toEqual([{ label: 'Throw an error' }]);
  });

  it('says when a helper can also just carry on', () => {
    const quiet = (line: number): DecisionGroup => ({
      type: 'group',
      kind: 'function',
      label: 'Run check',
      title: 'check(x)',
      side: 'server',
      at: at('lib/a.ts', line),
      callee: at('lib/check.ts', 1),
      nodes: [
        {
          type: 'decision',
          question: 'x?',
          label: 'x?',
          code: 'x',
          side: 'server',
          branches: [
            {
              label: 'no',
              ends: true,
              nodes: [
                {
                  type: 'end',
                  outcome: 'throw',
                  label: 'Throw an error',
                  text: 'throws',
                  side: 'server',
                },
              ],
            },
          ],
          otherwise: 'yes',
        },
      ],
    });
    const shared = indexSharedDecisions([request('p', [quiet(1)]), request('q', [quiet(2)])]);
    const [step] = sharedSteps(factorSharedDecisions(request('p', [quiet(1)]), shared));
    expect(step!.shared!.ends.map((end) => end.label)).toEqual([
      'Stop with an error — nothing catches it, so the server answers 500',
      'Carry on with the next step',
    ]);
  });

  it('never folds away a helper the request is sent from', () => {
    const sender = (line: number): DecisionGroup => ({
      type: 'group',
      kind: 'function',
      label: 'Run save',
      title: 'save()',
      side: 'browser',
      at: at('web/a.ts', line),
      callee: at('web/save.ts', 1),
      nodes: [
        {
          type: 'group',
          kind: 'request',
          label: 'Send',
          title: 'POST /x',
          side: 'server',
          nodes: [],
        },
      ],
    });
    const make = (id: string): ActionDecisions => ({
      flowId: id,
      title: id,
      nodes: [sender(1)],
      counts: { decisions: 0, outcomes: 0, queries: 0, requests: 1 },
      limits: [],
    });
    expect(indexSharedDecisions([make('x'), make('y')]).parts.size).toBe(0);
  });
});
