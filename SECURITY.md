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
  prints the exact path. If you move it into the repository with `-g`, FlowLens
  says so and `flowlens init --gitignore` will ignore it for you.
- **A `flowlens.config.json` is discovered, not requested.** The CLI walks up
  from the path you name, so on a repository you have just cloned, that
  repository is choosing your scan settings. Roots pointing outside the project
  earn a warning naming the directory, the wrapper-matching pattern is length
  capped before it is compiled, and `scan` always prints the config file it
  used. Read a config you did not write before trusting the scan, as you would
  any other file in an unfamiliar repository.
- **`trace.jsonl` records request paths and timings** from your running app. It
  contains no request bodies or headers by design, but paths can carry
  identifiers. Treat it as you would a log file.
- **The runtime tracer is for development.** Every integration example is guarded
  by `NODE_ENV`. It is not built or hardened for production traffic.
- **`flowlens serve` answers the dashboard and nothing else.** It is a local
  development server, and "local" is not by itself a boundary: every page open
  in your browser can already reach `127.0.0.1`. So:
  - `/api/*` sends **no CORS headers**, which is what stops another origin from
    reading your graph, and rejects any request that arrives with a foreign
    `Origin` — including a `POST /api/rescan`, which needs no readable response
    to be worth doing.
  - Every request must be addressed by **IP literal or `localhost`**. A request
    for `http://some.name:4177/` is refused, because that is what a DNS
    rebinding attack looks like.
  - **Span collection requires a token**, generated per run and printed with
    the URLs you copy. It is the one endpoint that must accept cross-origin
    writes — the app being traced is on its own port — so it cannot check who
    is asking and checks what they know. Fix it with `--token` or
    `$FLOWLENS_TOKEN` when you need a stable value.
  - Binding elsewhere with `--host` extends the token requirement to the whole
    API and prints a warning. There is still no user model: a token is a token.
  - `trace.jsonl` stops growing at 64 MB rather than filling the disk.

## Supported versions

Fixes land on `main` and in the latest published release only. The current
release is `1.0.x`, published to npm as `@flowslens/cli`, `@flowslens/core` and
`@flowslens/runtime`.
