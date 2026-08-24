/**
 * The trace event contract shared by `@flowlens/runtime` (which writes it) and
 * `@flowlens/core` (which merges it into the graph).
 *
 * Deliberately a flat, boring JSONL record: it has to be writable from a
 * browser, a Node process and a Mongoose hook without a transport library, and
 * readable years later.
 */

export const TRACE_VERSION = 1;

export type SpanKind =
  /** A click/submit observed in the browser. */
  | 'ui-action'
  /** An outbound request from the frontend. */
  | 'http-client'
  /** An inbound request handled by the backend. */
  | 'http-server'
  /** A controller or service method. */
  | 'method'
  /** A database operation. */
  | 'db';

export interface TraceAttributes {
  httpMethod?: string;
  path?: string;
  statusCode?: number;
  collection?: string;
  operation?: string;
  class?: string;
  method?: string;
  component?: string;
  /** Set when the span ended in an error. */
  error?: string;
  [key: string]: unknown;
}

export interface TraceEvent {
  v: number;
  /** One id per user action, propagated across the network boundary. */
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  attrs?: TraceAttributes;
}

/** Parse a `.flowlens/trace.jsonl` file, skipping malformed lines. */
export function parseTraceFile(contents: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent;
      if (typeof parsed?.traceId === 'string' && typeof parsed?.spanId === 'string') {
        events.push(parsed);
      }
    } catch {
      // A partially-flushed last line is normal while an app is running.
    }
  }
  return events;
}

/** Group spans into traces, each sorted by start time. */
export function groupTraces(events: TraceEvent[]): Map<string, TraceEvent[]> {
  const traces = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const existing = traces.get(event.traceId);
    if (existing) existing.push(event);
    else traces.set(event.traceId, [event]);
  }
  for (const spans of traces.values()) {
    spans.sort((a, b) => a.startedAt - b.startedAt);
  }
  return traces;
}
