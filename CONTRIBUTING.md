# Contributing to `@razroo/parallel-mcp`

Thanks for your interest in improving `parallel-mcp`! This repository is a
multi-package npm workspace that publishes three packages under the same
version line:

- `@razroo/parallel-mcp` (core orchestration + SQLite reference adapter)
- `@razroo/parallel-mcp-server` (MCP stdio + Streamable HTTP wrapper)
- `@razroo/parallel-mcp-testkit` (reusable conformance suite for alternative
  adapters)

## Ground rules

- **Keep the core durable semantics deterministic.** Every change that
  touches the state machine, leases, or retries must land with a matching
  test in `tests/` *and* a matching case in `testkit/src/suite.ts` if the
  behavior is part of the adapter contract. Adapter authors depend on the
  testkit codifying expected behavior.
- **Typed errors over generic ones.** When a new invalid state transition
  is introduced, throw one of the existing classes in `src/errors.ts` or
  add a new one; never throw a bare `Error` for domain-level failures.
- **No silent breaking changes.** The core, server, and testkit share a
  single `vX.Y.Z` tag. Any change that breaks downstream consumers (the
  MCP tool shape, the orchestrator method signatures, the event payload
  shape, the schema migrations) is a **major** version bump.
- **Docs are part of the diff.** If you change the public API, update the
  JSDoc, the `README.md`, and the relevant page under `docs/`. If you
  change the schema, update `src/migrations.ts` *and* add a migration
  upgrade test under `tests/migrations.test.ts`.

## Setting up

Requirements:

- Node **22+** (`.github/workflows/ci.yml` also pins a Node 20 matrix entry,
  so please don't use features above the declared `engines.node`).
- A working `better-sqlite3` build toolchain (on macOS, the Xcode CLT is
  usually enough).

```bash
git clone https://github.com/razroo/parallel-mcp.git
cd parallel-mcp
npm install
npm run build:all     # core, server, testkit
npm run test:all      # all three packages
npm run check         # strict TS check across workspaces
```

Run a quick end-to-end:

```bash
npm run example:fan-out
```

## Workspace layout

| Path          | Package                              | Purpose                                         |
| ------------- | ------------------------------------ | ----------------------------------------------- |
| `src/`        | `@razroo/parallel-mcp`               | Core orchestrator, store, worker, types, errors |
| `server/`     | `@razroo/parallel-mcp-server`        | MCP stdio + HTTP wrapper                        |
| `testkit/`    | `@razroo/parallel-mcp-testkit`       | Conformance suite                               |
| `examples/`   | —                                    | Runnable demos                                  |
| `bench/`      | —                                    | Throughput / contention micro-benchmarks        |
| `docs/`       | —                                    | Lifecycle, failure modes, adapter authoring     |
| `tests/`      | —                                    | Vitest suites for the core package              |

## Commit hygiene

- Prefer Conventional Commits style: `feat(core):`, `fix(server):`,
  `docs:`, `test:`, `chore(release):`, etc.
- One logical change per commit is nicer to review than a squashed PR.
- Every PR should pass `npm run check && npm run test:all && npm run build:all`
  locally before opening.

## Adding a new adapter

If you're building, say, a Postgres or MySQL adapter on top of this
contract:

1. Create a new npm package outside this repository (or propose a new
   workspace here).
2. Add `@razroo/parallel-mcp` and `@razroo/parallel-mcp-testkit` as
   dependencies.
3. Wire `runConformanceSuite({ createOrchestrator })` into a Vitest file.
4. Implement everything the suite exercises. If your backend genuinely
   cannot support lease expiry, opt out via
   `supportsLeaseExpiry: false`; any other skip should come with a
   justification in your adapter README.

See `docs/authoring-adapters.md` for a deeper walk-through.

## Releasing

Releases are fully automated from git tags. Only maintainers with npm
publish rights can cut a release.

1. Bump the version in the root, `server/`, and `testkit/`
   `package.json` files to the same value.
2. Update `CHANGELOG.md` (move `Unreleased` → the new version section,
   add a new empty `Unreleased` section).
3. Commit:
   ```bash
   git commit -am "chore(release): bump all workspaces to X.Y.Z"
   git push
   ```
4. Tag and push:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
5. `release.yml` will validate the tag, build / test / pack all three
   packages, publish each to npm with `--provenance`, and create a
   GitHub release with all three tarballs as assets.

## Reporting bugs / security issues

- Regular bugs: open an issue at
  <https://github.com/razroo/parallel-mcp/issues>.
- Security-sensitive reports: please use the private channel documented
  in [`SECURITY.md`](./SECURITY.md) rather than filing a public issue.
