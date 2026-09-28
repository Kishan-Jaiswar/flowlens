/**
 * Next.js request tracing in one line.
 *
 *   // instrumentation.ts
 *   export { register } from '@flowslens/runtime/next';
 *
 * Next calls `register()` once per server process, before any request. It is
 * also bundled for the Edge runtime, which has no `node:http`, so nothing
 * Node-only is imported here at the top: the tracer is loaded only once the
 * Node runtime is confirmed. Does nothing in production, on the Edge runtime,
 * or with `FLOWLENS_TRACING=off`.
 */
export async function register(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') return;
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  if (process.env['FLOWLENS_TRACING'] === 'off') return;

  const { installServerTracing } = await import('./server.js');
  installServerTracing();
  console.log('[flowlens] request tracing installed');
}
