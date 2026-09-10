import { useEffect } from 'react';

/**
 * How you wire the browser tracer into a Next.js app.
 *
 * It patches `fetch`/`XMLHttpRequest` in development only, so that a click and
 * the requests it causes share one trace id — which is what lets FlowLens say
 * "this button caused these three queries" rather than guessing from source.
 */
export default function App({
  Component,
  pageProps,
}: {
  Component: React.ComponentType<Record<string, unknown>>;
  pageProps: Record<string, unknown>;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    let uninstall: (() => void) | undefined;

    void import('@flowslens/runtime/browser').then(({ installBrowserTracer }) => {
      // The collector requires the token `flowlens serve` prints, so that a
      // page you did not write cannot forge spans into your graph. Put it in
      // your dev env file rather than here.
      const endpoint = process.env.NEXT_PUBLIC_FLOWLENS_SPANS;
      uninstall = installBrowserTracer(endpoint ? { endpoint } : {});
    });

    return () => uninstall?.();
  }, []);

  return <Component {...pageProps} />;
}
