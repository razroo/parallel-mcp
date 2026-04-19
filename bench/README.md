# Benchmarks

Small, self-contained throughput scripts. These are **not** regression guards —
they print numbers you can compare locally before and after a change to the
claim path or the schema.

## `claim-throughput.ts`

Measures how many `claimNextTask` + `completeTask` cycles per second the core
can do against a real sqlite file on disk, both single-worker and with N
workers contending over the same file.

```bash
npm run bench:claims
# or with custom parameters
npx tsx bench/claim-throughput.ts --tasks=5000 --workers=8 --busyTimeoutMs=10000
```

Output looks like:

```
parallel-mcp claim throughput bench
  tasks=2000 workers=4 busyTimeoutMs=5000

single worker  |   2000 tasks |    620 ms |   3225 claims/sec
4 workers      |   2000 tasks |    880 ms |   2272 claims/sec
```

Notes:

- Throughput is dominated by fsync on WAL journal commits, so numbers depend
  heavily on disk type (NVMe vs spinning vs network storage).
- Multi-worker throughput being **lower** than single-worker is expected: every
  writer takes an IMMEDIATE lock on the same sqlite file, so contention costs
  real wall-clock time. This bench exists partly to make that trade-off
  visible.
- If you see `SQLITE_BUSY` errors, bump `--busyTimeoutMs`.

## `claim-throughput-async.ts`

Async counterpart of the above, targeting an `AsyncParallelMcpStore`.
Defaults to the zero-overhead `MemoryParallelMcpStore`, which is useful
as an upper bound on the orchestrator+worker logic itself without any
storage cost. Optionally swaps in a live Postgres when `DATABASE_URL`
is set and `--store=postgres` is passed, for apples-to-apples numbers
against a real async backend.

```bash
npm run bench:claims:async
# or with custom parameters
npx tsx bench/claim-throughput-async.ts --tasks=5000 --workers=8
# against a live postgres
DATABASE_URL=postgres://user:pass@localhost:5432/pmcp_bench \
  npx tsx bench/claim-throughput-async.ts --store=postgres --tasks=2000 --workers=4
```

Output looks like:

```
parallel-mcp async claim throughput bench
  store=memory tasks=500 workers=4

single worker  |    500 tasks |     67 ms |   7484 claims/sec
4 workers      |    500 tasks |     64 ms |   7770 claims/sec
```

Notes:

- The in-memory numbers are a ceiling — the real orchestrator+worker
  cost without any disk or network. Expect 1–2 orders of magnitude
  drop against a real backing store.
- Postgres numbers are dominated by network round-trip. Running the
  adapter against a local `postgres` docker container gives you a
  reasonable lower bound; add more workers to see where the
  `SELECT ... FOR UPDATE SKIP LOCKED` contention curve flattens out.
- Single-worker results can be higher than multi-worker for very small
  task counts because of setup overhead — scale the `--tasks` flag up
  (≥10 000) for stable measurements.
