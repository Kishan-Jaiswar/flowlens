# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/Kishan-Jaiswar/flowlens/security/advisories/new)
rather than opening a public issue.

I will acknowledge within a few days and keep you updated until it is resolved.

## What FlowLens does with your code

Worth stating plainly, because this is a tool you point at a private codebase:

- **It reads source files. It does not execute them.** The analyzer parses syntax
  trees; it never imports or runs the project under analysis.
- **It never connects to a database.** Collections and fields are derived from
  schema declarations in source. The Mongoose plugin in `@flowlens/runtime` times
  queries your own application already makes.
- **It makes no network calls.** No telemetry, no accounts, no uploads. The
  dashboard binds to `127.0.0.1` by default.
- **Everything stays local.** Output goes to a `.flowlens/` directory inside your
  project, which is gitignored by default.

## Things to know

- **`.flowlens/graph.json` describes your architecture** — file paths, route
  names, collection names. It is gitignored, but do not publish it casually.
- **`.flowlens/trace.jsonl` records request paths and timings** from your running
  app. It contains no request bodies or headers by design, but paths can carry
  identifiers. Treat it as you would a log file.
- **The runtime tracer is for development.** Every integration example is guarded
  by `NODE_ENV`. It is not built or hardened for production traffic.
- **`flowlens serve` has no authentication.** It is a local development server
  and should not be exposed beyond localhost.

## Supported versions

While the project is pre-1.0, fixes land on `main` and in the latest release
only.
