# @flowslens/runtime

[![npm version](https://img.shields.io/npm/v/@flowslens/runtime)](https://www.npmjs.com/package/@flowslens/runtime)
[![npm downloads](https://img.shields.io/npm/dm/@flowslens/runtime)](https://www.npmjs.com/package/@flowslens/runtime)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Kishan-Jaiswar/flowlens/blob/main/LICENSE)

Zero-dependency, development-only request tracer for **Node.js, Next.js,
Express, NestJS, Mongoose and the native MongoDB driver**. Optional companion to
[Flowslens](https://www.npmjs.com/package/@flowslens/cli). Records what a request
_actually did_, so a path Flowslens found in your source can be confirmed rather
than assumed.

Static analysis proves a path **can** run. A trace proves it **did** — and tells
you how long each step took.

> **Not for production.** A development aid, not an APM. It appends spans to a
> local file and is meant to sit behind a `NODE_ENV` check.

---

## Do you need this?

**Probably not at first.** `@flowslens/cli` works entirely from your source code
with nothing installed in your app. Add this package only when you want:

- steps marked `confirmed` instead of `static`,
- real timings per step ("82ms of that 355ms was the products query"),
- the paths static analysis cannot see — dynamic routes, ORM helpers, a
  collection name computed at runtime.

---

## Install

```bash
npm install --save-dev @flowslens/runtime
```

Requires **Node 18.18 or newer**. No dependencies.

### One gotcha first: this package is ESM-only

There is no CommonJS build. What that means for you:

| Your app                             | Use this                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------- |
| ESM (`"type": "module"`, or `.mjs`)  | `import { flowlensHttp } from '@flowslens/runtime'`                         |
| TypeScript compiled to ESM           | `import { flowlensHttp } from '@flowslens/runtime'`                         |
| **CommonJS on Node 22.12+**          | `require('@flowslens/runtime')` works                                       |
| **CommonJS on Node 18, 20 or 22.11** | `await import('@flowslens/runtime')` — `require()` throws `ERR_REQUIRE_ESM` |

If you are on CommonJS and unsure, use `await import()` — it works everywhere,
and it is what the examples below do.

---

## Copy the block for your stack

### Express (CommonJS — the `require()` style)

```js
// app.js
const express = require('express');
const mongoose = require('mongoose');

const app = express();

async function enableTracing() {
  if (process.env.NODE_ENV === 'production') return;

  const { flowlensHttp, flowlensMongoose } = await import('@flowslens/runtime');

  app.use(flowlensHttp()); // one span per HTTP request
  mongoose.plugin(flowlensMongoose()); // one span per query, nested under it
}

enableTracing().then(() => app.listen(3000));
```

`flowlensHttp()` must be registered **before your routes**, so it wraps them.

### Express (ESM)

```js
// app.js
import express from 'express';
import mongoose from 'mongoose';
import { flowlensHttp, flowlensMongoose } from '@flowslens/runtime';

const app = express();

if (process.env.NODE_ENV !== 'production') {
  app.use(flowlensHttp());
  mongoose.plugin(flowlensMongoose());
}

app.listen(3000);
```

### NestJS

```ts
// src/main.ts
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  if (process.env.NODE_ENV !== 'production') {
    const { flowlensHttp, flowlensMongoose } =
      await import('@flowslens/runtime');

    app.use(flowlensHttp());
    mongoose.plugin(flowlensMongoose({ ignoreCollections: ['sessions'] }));
  }

  await app.listen(3000);
}

void bootstrap();
```

Register the Mongoose plugin **before** your models are compiled — in
`bootstrap()`, above `app.listen()` — or the hooks never attach.

### Next.js App Router — let the CLI write it

```bash
npx @flowslens/cli instrument .
```

It writes two new files and prints the rest — it never edits a file you
already have:

```ts
// instrumentation.ts — requests, and every query they run
export { register } from '@flowslens/runtime/next';
```

and `app/flowlens-tracer.tsx`, a client component that loads the click tracer
only while `NEXT_PUBLIC_FLOWLENS_SPANS` is set. Render `<FlowlensTracer />`
once, in the layout or a providers component. `register()` does nothing in
production or on the Edge runtime, and the request, the database call and the
click all share one trace even though Turbopack bundles them separately.

### The native MongoDB driver

```ts
import { traceDb } from '@flowslens/runtime';

const db = traceDb(client.db('app')); // a plain pass-through in production
```

One span per operation — `find` and `aggregate` when the cursor is drained —
written only while a request is being traced, so start-up index creation and
background workers stay out of the recording.

### Next.js / React — link a click to the requests it caused

This is what lets Flowslens say "this button caused these three queries" instead
of inferring it from source.

```tsx
// pages/_app.tsx  (or a client component in app/layout.tsx)
import { useEffect } from 'react';

export default function App({ Component, pageProps }) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    let uninstall;

    void import('@flowslens/runtime/browser').then(
      ({ installBrowserTracer }) => {
        uninstall = installBrowserTracer({
          // `flowlens serve` prints this line, token included.
          endpoint: 'http://localhost:4177/__flowlens/spans?token=…',
        });
      },
    );

    return () => uninstall?.();
  }, []);

  return <Component {...pageProps} />;
}
```

**Or add nothing to your bundle at all.** While `flowlens serve` is running it
serves the tracer itself — paste this in your browser console:

```js
import('http://127.0.0.1:4177/__flowlens/browser.js?token=…').then((m) =>
  m.installBrowserTracer(),
);
```

The token changes every time the dashboard starts. If the endpoint lives in a
file — `NEXT_PUBLIC_FLOWLENS_SPANS` in `.env.local`, as `flowlens instrument`
sets up — start the dashboard with a fixed one so the URL keeps working:
`flowlens serve . --token flowlens-dev` (or `FLOWLENS_TOKEN=flowlens-dev`).

---

## Then: record and merge

1. **Start your app** with the code above in place.
2. **Use the feature** you care about — click the button, submit the form. Spans
   are appended as requests happen.
3. **Merge the recording** into the graph:

```bash
flowlens scan .
flowlens trace .
```

Steps the trace confirms are marked `confirmed`, and each carries inclusive and
exclusive timings.

---

## Where the spans go

To a machine-local cache file — never into your repository.

The tracer derives that path from **the directory your app was started in**; the
CLI derives it from **the project path you scan**. When those are the same
directory, `flowlens trace .` finds the recording with no flag.

When they differ — an API started from `./api` in a repo you scan from the root
— name the file on both sides:

```bash
# terminal 1: your app
FLOWLENS_TRACE=/tmp/trace.jsonl npm start

# terminal 2: Flowslens
flowlens trace . --trace /tmp/trace.jsonl
```

`flowlens serve` prints the path it is reading, which is the fastest way to see
which one is in play.

**What is in the file:** request paths, methods, timings and query shapes. **No
request bodies and no headers**, by design. Paths can still carry identifiers, so
treat it as you would a log file.

---

## Options

Every option is optional; the defaults are meant to be right.

**`flowlensHttp(options)`**

| Option            | Type                   | Default                                                                  |
| ----------------- | ---------------------- | ------------------------------------------------------------------------ |
| `ignore`          | `(string \| RegExp)[]` | Skips `/health`, `/favicon.ico`, `/_next/*`, `/static/*`, `/__flowlens*` |
| `file`            | `string`               | `$FLOWLENS_TRACE`, else the machine-local cache path                     |
| `enabled`         | `boolean`              | `true` — set `false` to turn tracing off entirely                        |
| `batchSize`       | `number`               | Flush after this many buffered events                                    |
| `flushIntervalMs` | `number`               | Flush at least this often                                                |
| `onError`         | `(error) => void`      | Called on write failures                                                 |

**`flowlensMongoose(options)`**

| Option              | Type       | Purpose                                          |
| ------------------- | ---------- | ------------------------------------------------ |
| `ignoreCollections` | `string[]` | Skip session stores, job queues, log collections |

**`installBrowserTracer(options)`**

| Option           | Type     | Purpose                                                                                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`       | `string` | Where to POST spans, token included — `flowlens serve` prints it. Loaded from the dashboard, the tracer reads its own URL and needs nothing. |
| `ignoreSelector` | `string` | Ignore clicks matching this CSS selector.                                                                                                    |
| `maxLabelLength` | `number` | Max characters of element text used as a label.                                                                                              |

Returns a function that uninstalls it again.

**Time one method on its own**, when it is the part you suspect. `traceMethod`
wraps a **call**, so use it inside the method and `await` it — the class and
method names are separate arguments, and it returns whatever your function
returns:

```js
import { traceMethod } from '@flowslens/runtime';

class OrdersService {
  async create(dto) {
    return traceMethod('OrdersService', 'create', () => this.doCreate(dto));
  }
}
```

Outside a traced request it simply calls straight through, so it is safe to
leave in place.

---

## All exports

| Export                            | Purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `flowlensHttp()`                  | Express/NestJS middleware — one span per request. |
| `flowlensMongoose()`              | Mongoose plugin — one span per query.             |
| `traceDb(db)`, `traceCollection`  | Native MongoDB driver — one span per operation.   |
| `installServerTracing()`          | Any `node:http` server with no middleware chain.  |
| `register()`                      | `@flowslens/runtime/next` — Next.js in one line.  |
| `traceMethod(class, method, fn)`  | Time one call as its own span.                    |
| `installBrowserTracer(options)`   | Browser: correlate a click with its requests.     |
| `TraceSink`, `getSink`, `setSink` | Where spans are written.                          |
| `withContext`, `currentContext`   | The active trace context.                         |
| `TRACE_HEADER`, `SPAN_HEADER`     | Header names carrying correlation ids.            |

`installBrowserTracer` comes from `@flowslens/runtime/browser`, `register` from
`@flowslens/runtime/next`; everything else from `@flowslens/runtime`.

---

## Related packages

- **[`@flowslens/cli`](https://www.npmjs.com/package/@flowslens/cli)** — the
  `flowlens` command that merges these recordings and shows the result. Start
  there.
- **[`@flowslens/core`](https://www.npmjs.com/package/@flowslens/core)** — the
  graph engine, including `mergeRuntimeTrace`.

## Documentation

[`@flowslens/cli`](https://www.npmjs.com/package/@flowslens/cli) documents the
commands that read what this package records, and
[`@flowslens/core`](https://www.npmjs.com/package/@flowslens/core) documents the
graph the spans are merged into. Source and changelog:
**[github.com/Kishan-Jaiswar/flowlens](https://github.com/Kishan-Jaiswar/flowlens)**.

Bug reports: [GitHub issues](https://github.com/Kishan-Jaiswar/flowlens/issues),
or **jaiswarkishan78@gmail.com**.

## Licence

MIT
