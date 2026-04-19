# `@razroo/parallel-mcp-postgres`

**Status: alpha / work in progress.** This workspace is a **reference**
implementation of a Postgres-backed `ParallelMcpStore`. It exists so that
alternative adapter authors can see the expected shape, schema, and
conformance-testing setup. It does **not** yet implement every orchestrator
operation — see the `NotImplementedError` throw sites in `src/store.ts`.

If you need a production-ready Postgres adapter today, use
`@razroo/parallel-mcp`'s bundled `SqliteParallelMcpStore` against a durable
file while this adapter matures, or help us finish it.

## Schema

The canonical schema is a single SQL string exported as `POSTGRES_SCHEMA`.
It is a straight port of `src/schema.ts` from the core package, with:

- `JSONB` columns where SQLite used `TEXT`-encoded JSON.
- `BIGSERIAL` for `events.id` to preserve monotonic ordering.
- `TIMESTAMPTZ` for every timestamp.
- A handful of partial indexes (`WHERE status = 'active'`) that Postgres
  handles natively but SQLite fakes with composite indexes.

Apply it once against a fresh database:

```ts
import { Pool } from 'pg'
import { POSTGRES_SCHEMA } from '@razroo/parallel-mcp-postgres/schema'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await pool.query(POSTGRES_SCHEMA)
```

In production you'll almost always wrap this in a real migration tool
(`drizzle-kit`, `node-pg-migrate`, etc.) — we publish it as a single
string so you can copy-paste it into a `0001_init.sql` file if you want.

## Usage (will work once the adapter is complete)

```ts
import { Pool } from 'pg'
import { ParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { PostgresParallelMcpStore } from '@razroo/parallel-mcp-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresParallelMcpStore({ pool })
await store.migrate() // or own migrations out-of-band

const orchestrator = new ParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })
```

## Why async vs sync?

`ParallelMcpStore` is currently a **synchronous** interface, because the
reference SQLite adapter talks to `better-sqlite3` in-process. A
production Postgres adapter needs to be async — `pg` is network I/O.

The path forward is to introduce an `AsyncParallelMcpStore` sibling
interface in the core package and let adapters implement whichever shape
makes sense for their backend. Until that lands, every operation in this
adapter throws `NotImplementedError` rather than pretending to be sync.

Tracking issue: <https://github.com/razroo/parallel-mcp/issues> (file
one if you want to lead this).

## Running against a live Postgres

Tests use a real Postgres. Set `PG_TEST_URL` in your environment and
run:

```bash
PG_TEST_URL=postgres://localhost:5432/parallel_mcp_test npm test
```

Without `PG_TEST_URL` the live-database tests are skipped; the rest of
the suite (schema string, listener wiring, unimplemented-error shape)
still runs.

## Contributing

Please read the root [`CONTRIBUTING.md`](../../CONTRIBUTING.md). The fast
path to getting this adapter to parity is:

1. Implement one method end-to-end (e.g. `createRun`).
2. Add a Vitest test under `tests/` that exercises it against `PG_TEST_URL`.
3. Wire it into `runConformanceSuite` from `@razroo/parallel-mcp-testkit`.
4. Repeat.

The typed errors you must throw are documented in
[`../../docs/authoring-adapters.md`](../../docs/authoring-adapters.md).
