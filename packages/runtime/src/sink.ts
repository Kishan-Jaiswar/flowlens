import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TRACE_VERSION = 1;

export type SpanKind = 'ui-action' | 'http-client' | 'http-server' | 'method' | 'db';

export interface TraceEvent {
  v: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  name: string;
  startedAt: number;
  durationMs: number;
  attrs?: Record<string, unknown>;
}

export interface SinkOptions {
  /** Where to append trace events. Defaults to `.flowlens/trace.jsonl`. */
  file?: string;
  /** Flush after this many buffered events. */
  batchSize?: number;
  /** Flush at least this often, in ms. */
  flushIntervalMs?: number;
  /** Set false to disable tracing entirely (e.g. in production). */
  enabled?: boolean;
  /** Called on write failures. Defaults to a single warning. */
  onError?: (error: unknown) => void;
}

/**
 * Buffered JSONL writer.
 *
 * Tracing must never be the reason an app gets slower or falls over, so writes
 * are batched, appended (never rewritten), and every failure is swallowed after
 * one warning. A dropped span is always preferable to a broken request.
 */
export class TraceSink {
  private readonly file: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly onError: (error: unknown) => void;

  private buffer: TraceEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private warned = false;
  private closed = false;

  enabled: boolean;

  constructor(options: SinkOptions = {}) {
    this.file = resolve(options.file ?? '.flowlens/trace.jsonl');
    this.batchSize = options.batchSize ?? 32;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.enabled = options.enabled ?? true;
    this.onError =
      options.onError ??
      ((error) => {
        if (this.warned) return;
        this.warned = true;
        console.warn(`[flowlens] tracing disabled after write error: ${String(error)}`);
      });

    if (this.enabled) this.ensureDirectory();
    // Do not hold the process open just to flush traces.
    process.once('exit', () => this.flush());
  }

  write(event: TraceEvent): void {
    if (!this.enabled || this.closed) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    const lines = this.buffer.map((event) => JSON.stringify(event)).join('\n');
    this.buffer = [];
    try {
      appendFileSync(this.file, `${lines}\n`, 'utf8');
    } catch (error) {
      this.enabled = false;
      this.onError(error);
    }
  }

  close(): void {
    this.flush();
    this.closed = true;
  }

  private ensureDirectory(): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.enabled = false;
      this.onError(error);
    }
  }
}

let defaultSink: TraceSink | undefined;

export function getSink(options?: SinkOptions): TraceSink {
  if (!defaultSink) defaultSink = new TraceSink(options);
  return defaultSink;
}

/** Replace the process-wide sink (used by tests). */
export function setSink(sink: TraceSink): void {
  defaultSink = sink;
}
