# @flowlens/runtime

Zero-dependency runtime tracer for
[FlowLens](https://github.com/Kishan-Jaiswar/flowlens). Opt-in, development-only
instrumentation that records what a request *actually did*, so a statically
derived graph can be confirmed rather than assumed.

Static analysis proves a path **can** exist. A trace proves it **did**.

```bash
npm install --save-dev @flowlens/runtime
```

> **Not built for production.** This is a development aid, not an APM. It writes
> spans to a local file and is meant to be switched on behind `NODE_ENV`.

## Usage

Three independent pieces — use only the ones you want.

```js
// HTTP: one span per request.
import { flowlensHttp } from '@flowlens/runtime';
app.use(flowlensHttp());

// Mongoose: one span per query, nested under the request that caused it.
import { flowlensMongoose } from '@flowlens/runtime';
mongoose.plugin(flowlensMongoose());

// Any function worth timing on its own.
import { traceMethod } from '@flowlens/runtime';
const create = traceMethod('OrdersService.create', originalCreate);
```

In the browser, correlate a click with the request it caused:

```js
import { installBrowserTracer } from '@flowlens/runtime/browser';

if (process.env.NODE_ENV !== 'production') {
  // Returns a function that uninstalls it again.
  installBrowserTracer({ endpoint: 'http://localhost:4177/__flowlens/spans' });
}
```

The FlowLens CLI also serves this file at `/__flowlens/browser.js` while
`flowlens serve` is running, so nothing has to be added to your bundle.

Then merge the recording into the graph:

```bash
flowlens trace . --trace .flowlens/trace.jsonl
```

Steps confirmed by a trace are marked `confirmed`, and each carries inclusive
and exclusive timings — so "the request took 355ms" becomes "82ms of that was
the products query".

## Documentation

**https://github.com/Kishan-Jaiswar/flowlens**

## Licence

MIT
