import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runMcp } from '../packages/cli/dist/commands/mcp.js';
import { EXAMPLE_ROOT } from './helpers.js';

/**
 * `flowlens mcp` — the graph as tools an AI assistant calls, over the Model
 * Context Protocol on stdio. Driven here the way a client drives it: JSON-RPC
 * lines in, JSON-RPC lines out, nothing else on stdout.
 */
/** The parts of a JSON-RPC answer these tests read. */
interface Answer {
  result?: {
    protocolVersion?: string;
    capabilities?: unknown;
    serverInfo?: { name: string };
    tools?: Array<{
      name: string;
      inputSchema: { type: string };
      annotations: { readOnlyHint: boolean };
    }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function client() {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: Answer) => void>();
  const stray: string[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const message = JSON.parse(line) as { id?: number };
      const resolve = message.id !== undefined ? pending.get(message.id) : undefined;
      if (resolve) resolve(message as Answer);
      else stray.push(line);
    }
  });
  runMcp({ root: EXAMPLE_ROOT, version: 'test', input, output });

  let next = 1;
  const request = (method: string, params?: unknown) =>
    new Promise<Answer>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = await request('tools/call', { name, arguments: args });
    return {
      text: answer.result?.content?.[0]?.text ?? '',
      isError: answer.result?.isError === true,
    };
  };
  const notify = (method: string) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, call, notify, stray, input };
}

describe('flowlens mcp', () => {
  const mcp = client();

  it('completes the handshake and offers only read-only tools', async () => {
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(init.result!.protocolVersion).toBe('2025-03-26');
    expect(init.result!.capabilities).toEqual({ tools: {} });
    expect(init.result!.serverInfo.name).toBe('flowlens');
    mcp.notify('notifications/initialized');

    const list = await mcp.request('tools/list');
    const names = list.result!.tools!.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_actions',
        'explain_action',
        'where_is_code_used',
        'impact_of_change',
        'find_issues',
        'changes_impact',
        'tests_for_action',
        'action_performance',
        'find_unused',
        'rescan',
      ]),
    );
    for (const tool of list.result!.tools!) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('answers an unknown client revision with its own', async () => {
    const init = await mcp.request('initialize', { protocolVersion: '1999-01-01' });
    expect(init.result!.protocolVersion).toBe('2025-06-18');
  });

  it('lists actions, filtered by words', async () => {
    const { text } = await mcp.call('list_actions', { filter: 'submit order' });
    expect(text).toContain('orderform-submit-order');
    expect(text).toContain('POST /orders');
  });

  it('explains an action end to end, found by its title', async () => {
    const { text, isError } = await mcp.call('explain_action', { action: 'Submit Order' });
    expect(isError).toBe(false);
    expect(text).toContain('## At a glance');
    expect(text).toContain('POST /orders');
  });

  it('says which actions run through a file', async () => {
    const { text } = await mcp.call('where_is_code_used', {
      location: 'web/src/components/OrderForm.tsx',
    });
    expect(text).toContain('orderform-submit-order');
  });

  it('walks back from a symbol to the actions it would break', async () => {
    const { text } = await mcp.call('impact_of_change', { symbol: 'OrdersService.create' });
    expect(text).toContain('Actions affected');
    expect(text).toContain('orderform-submit-order');
  });

  it('writes the tests to add for an action', async () => {
    const { text } = await mcp.call('tests_for_action', { action: 'orderform-submit-order' });
    expect(text).toContain("it.todo('answers 404");
  });

  it('lists the code nothing uses', async () => {
    const { text } = await mcp.call('find_unused');
    expect(text).toContain('Endpoints no frontend calls');
    expect(text).toContain('CustomerSchema');
  });

  it('says a timing was never measured instead of inventing one', async () => {
    const { text } = await mcp.call('action_performance', { action: 'orderform-submit-order' });
    expect(text).toContain('not measured yet');
  });

  it('reports a tool that cannot answer as a result the model can read', async () => {
    const missing = await mcp.call('explain_action', { action: 'no such thing at all' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('list_actions');

    const unknown = await mcp.request('tools/call', { name: 'delete_everything' });
    expect(unknown.error?.code).toBe(-32602);
  });

  it('answers ping, rejects unknown methods, and keeps stdout to protocol', async () => {
    expect((await mcp.request('ping')).result).toEqual({});
    expect((await mcp.request('resources/list')).error?.code).toBe(-32601);
    // A notification gets no reply; nothing unsolicited was ever written.
    expect(mcp.stray).toEqual([]);
  });
});
