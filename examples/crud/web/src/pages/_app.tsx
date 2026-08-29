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

    void import('@flowlens/runtime/browser').then(({ installBrowserTracer }) => {
      uninstall = installBrowserTracer({
        endpoint: 'http://localhost:4177/__flowlens/spans',
      });
    });

    return () => uninstall?.();
  }, []);

  return <Component {...pageProps} />;
}
