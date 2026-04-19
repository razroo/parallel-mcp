# `@razroo/parallel-mcp-postgres`

**Status: beta.** This workspace ships a Postgres-backed
`AsyncParallelMcpStore` that implements the full orchestrator contract
pinned by `@razroo/parallel-mcp-testkit`'s async conformance suite. It is
a straight port of the reference `SqliteParallelMcpStore`, with:

- `JSONB` columns where SQLite used `TEXT`-encoded JSON
- `BIGSERIAL` on `events.id` so the event cursor stays monotonic
- `TIMESTAMPTZ` for every timestamp
- `SELECT … FOR UPDATE SKIP LOCKED` for multi-worker-safe claims

## Schema

The canonical schema is a single SQL string exported as `POSTGRES_SCHEMA`.
Apply it once against a fresh database:

```ts
import { Pool } from 'pg'
import { POSTGRES_SCHEMA } from '@razroo/parallel-mcp-postgres/schema'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await pool.query(POSTGRES_SCHEMA)
```

In production you'll almost always wrap this in a real migration tool
(`drizzle-kit`, `node-pg-migrate`, etc.). We publish it as a single
string so you can copy-paste it into a `0001_init.sql` file if you want.

## Usage

```ts
import { Pool } from 'pg'
import { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { PostgresParallelMcpStore } from '@razroo/parallel-mcp-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresParallelMcpStore({ pool, autoMigrate: true })

const orchestrator = new AsyncParallelMcpOrchestrator(store, {
  defaultLeaseMs: 30_000,
})

const run = await orchestrator.createRun({ namespace: 'demo' })
await orchestrator.enqueueTask({ runId: run.id, kind: 'greet' })
```

The store implements the async interface, so you drive it through
`AsyncParallelMcpOrchestrator` — **not** the synchronous
`ParallelMcpOrchestrator`.

## Running the live conformance suite

Tests run against a real Postgres when `DATABASE_URL` is set and are
skipped otherwise.

```bash
docker run --rm -d --name pmcp-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:16

DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npm run test --workspace @razroo/parallel-mcp-postgres
```

Each test spawns its own schema (`pmcp_test_<rand>`), runs the full
`runAsyncConformanceSuite`, and drops the schema on cleanup so the runs
are independent.

## Pool ownership

`PostgresParallelMcpStore` does **not** call `pool.end()` in `close()` —
the pool belongs to the caller. This matches the idiom for long-running
servers that share a pool across many stores.

## Contributing

Please read the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Typed
errors and the full set of operations you need to honor when writing an
adapter from scratch are documented in
[`../../docs/authoring-adapters.md`](../../docs/authoring-adapters.md).
