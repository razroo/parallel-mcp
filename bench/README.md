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
