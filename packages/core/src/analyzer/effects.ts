/**
 * Work that leaves the application.
 *
 * A flow that reaches `stripe.charges.create()` or `emailQueue.add('welcome')`
 * does not end there — it ends somewhere Flowslens cannot follow. Those are
 * different statements, and only one of them is true. Before this pass, both
 * looked identical in the graph: the chain simply stopped after the last
 * collection, and a developer reading it would conclude that creating an order
 * writes a row and nothing else.
 *
 * So each recognised effect becomes a terminal `external-effect` node that says
 * what it is and admits that the far side is unread. The list below is
 * deliberately short and literal; an unrecognised call is left alone rather
 * than guessed at, on the same principle as every other analyzer here.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { callsIn, calleeMember, calleeReceiver, lineOf, readString } from './ast.js';

/** What an effect does, for grouping and for the sentence the CLI prints. */
export type EffectKind = 'http' | 'queue' | 'cache' | 'email' | 'storage' | 'realtime' | 'payment';

export const EFFECT_LABEL: Record<EffectKind, string> = {
  http: 'called',
  queue: 'enqueued to',
  cache: 'cached in',
  email: 'sent mail via',
  storage: 'stored in',
  realtime: 'pushed over',
  payment: 'charged via',
};

interface EffectRule {
  kind: EffectKind;
  /** Receiver head that identifies the client, e.g. `stripe`, `s3`. */
  heads: readonly string[];
  /** Methods on that client which actually perform the effect. */
  members: readonly string[];
  /** How the node is labelled when the rule matches. */
  target: string;
}

/**
 * Both halves are required to match, always.
 *
 * `queue.add(...)` is a job; `array.add(...)` is not, and `cache.get()` is a
 * cache read while `params.get()` is a URL. Keying on the method name alone
 * produced exactly those false positives, so every rule names its client.
 */
const RULES: readonly EffectRule[] = [
  {
    kind: 'queue',
    heads: ['queue', 'jobQueue', 'bull', 'bullmq', 'boss', 'producer', 'kafka'],
    members: ['add', 'addBulk', 'createJob', 'send', 'publish', 'enqueue', 'dispatch'],
    target: 'job queue',
  },
  {
    kind: 'cache',
    heads: ['redis', 'cache', 'ioredis', 'cacheManager', 'redisClient'],
    members: ['get', 'set', 'del', 'mget', 'mset', 'expire', 'incr', 'decr', 'hget', 'hset'],
    target: 'cache',
  },
  {
    kind: 'email',
    heads: ['transporter', 'mailer', 'mail', 'sendgrid', 'ses', 'resend', 'postmark', 'smtp'],
    members: ['sendMail', 'send', 'sendEmail', 'sendTemplate', 'sendBulk'],
    target: 'email provider',
  },
  {
    kind: 'storage',
    heads: ['s3', 'bucket', 'storage', 'blob', 'gcs', 'cloudinary', 'minio'],
    members: ['upload', 'putObject', 'getObject', 'deleteObject', 'getSignedUrl', 'copyObject'],
    target: 'object storage',
  },
  {
    kind: 'realtime',
    heads: ['io', 'socket', 'ws', 'pusher', 'gateway', 'server'],
    members: ['emit', 'broadcast', 'publish', 'to', 'trigger'],
    target: 'socket clients',
  },
  {
    kind: 'payment',
    heads: ['stripe', 'razorpay', 'paypal', 'braintree', 'payments'],
    members: ['create', 'capture', 'refund', 'charge', 'confirm', 'cancel'],
    target: 'payment provider',
  },
];

/**
 * Heads that are also recognised as a suffix, so `ordersQueue` matches `queue`.
 *
 * Nest's own idiom is `@InjectQueue('orders') private ordersQueue: Queue`, and
 * an exact-name list misses every one of them. Restricted to words that mean
 * only one thing when they end an identifier: `emailQueue` is a queue, but
 * `httpClient` is not a payment client, which is why `client` is not here.
 */
const SUFFIXABLE = new Set([
  'queue',
  'cache',
  'mailer',
  'mail',
  'storage',
  'bucket',
  'stripe',
  'redis',
  'producer',
]);

/** HTTP clients whose first argument may be an absolute URL. */
const HTTP_CALLERS = new Set(['fetch', 'axios', 'got', 'request', 'superagent', 'ky']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);

/**
 * Hosts that are the application itself, not a third party.
 *
 * A backend calling its own `http://localhost:3000/internal` is an internal
 * hop; labelling it "external" would be wrong in the one place developers are
 * most likely to look.
 */
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;

/**
 * Record every external effect inside `scope`, attributed to `ownerId`.
 *
 * Mirrors `linkDbOperations`: same call sites, same ownership rules, so an
 * Express handler, a Nest service method and a Next route handler all get the
 * same treatment without any of them knowing about this file.
 */
export function linkExternalEffects(
  scope: Node,
  rel: string,
  graph: FlowGraph,
  ownerId: string,
  site: string,
): number {
  let linked = 0;

  for (const call of callsIn(scope)) {
    const member = calleeMember(call);
    const receiver = calleeReceiver(call);
    const found = matchEffect(receiver, member, call);
    if (!found) continue;

    const effectId = ids.externalEffect(found.target, `${site}:${lineOf(call)}`);
    graph.addNode({
      id: effectId,
      kind: 'external-effect',
      label: found.label,
      source: { file: rel, line: lineOf(call) },
      meta: {
        effectKind: found.kind,
        target: found.target,
        call: receiver ? `${receiver}.${member}` : member,
        /**
         * The honest part. Every consumer — dashboard, feature document, the
         * `flow` command — can use this to say "Flowslens does not read what
         * happens here" instead of implying the flow is complete.
         */
        unread: true,
      },
    });
    graph.addEdge({ from: ownerId, to: effectId, kind: 'emits' });
    linked += 1;
  }

  return linked;
}

interface EffectMatch {
  kind: EffectKind;
  target: string;
  label: string;
}

function matchEffect(
  receiver: string | undefined,
  member: string,
  call: Node,
): EffectMatch | undefined {
  const http = matchHttp(receiver, member, call);
  if (http) return http;

  if (!receiver) return undefined;
  const parts = receiver.split('.');
  // `this.stripe.charges` and `stripe.charges` both identify themselves by a
  // segment, not by position, because injected clients sit behind `this`.
  for (const rule of RULES) {
    if (!rule.members.includes(member)) continue;
    if (!parts.some((part) => matchesHead(part, rule.heads))) continue;
    return { kind: rule.kind, target: rule.target, label: `${rule.target} (${member})` };
  }
  return undefined;
}

function matchesHead(part: string, heads: readonly string[]): boolean {
  for (const head of heads) {
    if (part === head) return true;
    if (!SUFFIXABLE.has(head)) continue;
    // `ordersQueue`, but not `queued` or `dequeue`.
    if (part.length > head.length && part.toLowerCase().endsWith(head)) return true;
  }
  return false;
}

/**
 * A request to a host that is not this application.
 *
 * Only absolute URLs count. A relative path on the server is either an internal
 * hop or a mistake, and either way naming a host Flowslens has not seen would be
 * inventing one.
 */
function matchHttp(
  receiver: string | undefined,
  member: string,
  call: Node,
): EffectMatch | undefined {
  const callee = receiver ? `${receiver}.${member}` : member;
  const head = receiver?.split('.').pop() ?? member;
  const isHttp =
    HTTP_CALLERS.has(callee) ||
    (HTTP_CALLERS.has(head) && HTTP_VERBS.has(member)) ||
    HTTP_CALLERS.has(member);
  if (!isHttp) return undefined;

  const [first] = Node.isCallExpression(call) ? call.getArguments() : [];
  const url = readString(first) ?? literalHead(first) ?? urlFromOptions(first);
  if (!url) return undefined;

  const host = hostOf(url);
  if (!host || LOCAL_HOSTS.test(host)) return undefined;

  return { kind: 'http', target: host, label: host };
}

/** `axios({ url: 'https://api.stripe.com/v1/charges' })` */
function urlFromOptions(argument: Node | undefined): string | undefined {
  if (!argument || !Node.isObjectLiteralExpression(argument)) return undefined;
  for (const property of argument.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    if (property.getName() !== 'url') continue;
    return readString(property.getInitializer());
  }
  return undefined;
}

function hostOf(url: string): string | undefined {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return match?.[1];
}

/**
 * Template literals hide the interesting URLs: `` `${BASE}/charges` `` is the
 * shape real code uses. Reading the literal head is enough to name the host
 * when the base is inline; when it is a constant, this returns nothing and the
 * call is skipped rather than mislabelled.
 */
export function literalHead(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.getKind() !== SyntaxKind.TemplateExpression) return undefined;
  const text = node.getText();
  const match = /^[`'"]?(https?:\/\/[^$`'"]+)/i.exec(text);
  return match?.[1];
}
