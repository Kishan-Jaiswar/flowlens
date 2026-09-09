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
  schema declarations in source. The Mongoose plugin in `@flowslens/runtime` times
  queries your own application already makes.
- **It makes no network calls.** No telemetry, no accounts, no uploads. The
  dashboard binds to `127.0.0.1` by default.
- **It never writes into the project it reads.** A scan leaves your repository
  byte-for-byte unchanged, so `git status` afterwards is empty. Artifacts go to
  the machine-local OS cache, keyed by project path:

  | OS      | Location                                             |
  | ------- | ---------------------------------------------------- |
  | Linux   | `$XDG_CACHE_HOME/flowlens`, else `~/.cache/flowlens` |
  | macOS   | `~/Library/Caches/flowlens`                          |
  | Windows | `%LOCALAPPDATA%\flowlens\Cache`                      |

  `FLOWLENS_CACHE` (absolute paths only) moves it. `flowlens init` is the one
  command that writes to your project, because writing a config file is what you
  asked it to do — `--print` avoids even that.

## Things to know

- **`graph.json` describes your architecture** — file paths, route names,
  collection names. It sits in the cache rather than your repository, so it will
  not be committed by accident, but do not publish it casually. `flowlens serve`
  prints the exact path.
- **`trace.jsonl` records request paths and timings** from your running app. It
  contains no request bodies or headers by design, but paths can carry
  identifiers. Treat it as you would a log file.
- **The runtime tracer is for development.** Every integration example is guarded
  by `NODE_ENV`. It is not built or hardened for production traffic.
- **`flowlens serve` has no authentication.** It is a local development server
  and should not be exposed beyond localhost.

## Supported versions

Fixes land on `main` and in the latest published release only. The current
release is `1.0.x`, published to npm as `@flowslens/cli`, `@flowslens/core` and
`@flowslens/runtime`.
