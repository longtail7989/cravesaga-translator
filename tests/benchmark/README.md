# Isolated extension-origin cache benchmark

Open `tests/benchmark/index.html` under the installed extension origin after staging the four production candidate modules in the adjacent `candidate/` directory:

```
tests/benchmark/
  index.html
  benchmark.css
  runner.mjs
  generator.worker.js
  candidate/
    cache-store.mjs
    cache.mjs
    core.mjs
    reliability.mjs
```

The parent is responsible for staging candidates. This implementation does not modify the installer, manifest, production modules, or existing tests. A relocated `/benchmark/index.html` also works when the relative layout is preserved. It requires an extension CSP permitting self scripts and self Workers; no inline scripts, eval, network, providers, credentials, or rAF are used by the browser implementation. `smoke.cjs` is Node-only and is not loaded by the HTML.

## Runner interface

- Click `#start`: event handler returns immediately; the asynchronous job is available as `window.__benchPromise`. Candidates load lazily, and missing files produce a safe failure summary in the UI.
- Click `#stop`: requests cooperative cancellation. The current bounded operation completes before owned DB cleanup. Wait until `active === false` and `cleanupComplete === true` before closing.
- `window.__benchState` and `pre#results` contain the same safe JSON summary. No generated source/translation samples are exposed in results.
- Useful fields: `phase`, `progress`, `active`, `completed`, `cancelled`, `cleanupComplete`, `cleanupBlocked`, `ownedDatabases`, `results`, `error`, `allPassed`.
- `completed` means the full three-dataset sequence ended, including any preflight skips or test failures. **Only `allPassed === true` means all three passed.** A cancelled run has `completed: false`.
- Each dataset exposes `cleanup.deleted` or `cleanup.notCreated`. A cleanup failure blocks subsequent datasets and disables re-run. Do not interpret an unresolved/blocked cleanup as success.
- Re-run is enabled after normal cleanup. A new cryptographically random run ID gives separate names; deterministic seeds keep content and sampling reproducible within each fixed size.

## Fixed workload

Sequential **200, 500, 700 decimal MB** logical payloads. Names are strictly `crave-ai-bench-<randomhex>-<size>`; every DB is destroyed before creating the next. Database operations are ownership guarded; no production-cache database is opened, counted, cleared, or deleted.

A local Worker generates exactly 256 records per request. Mixed short names, effect sentences, and profile-length fictional RPG-like text have high-entropy Han/Hangul bodies. These are synthetic strings, not real translations or a copyrighted corpus. Each record has a unique numeric prefix, identical in source and translation; no other protected numbers, tags, or variables occur. Only the current bounded batch, ≤32 normalization results at a time, ≤1024 retained source/result checking samples, and the separately bounded warm/hot Map are needed. There is no dataset-sized application array.

Logical size is the sum of `byteSize(makeCacheEntry(...))` for normalized entries, including metadata and `time`. CacheStore.put redoes validation/hashing/timestamps; current 13-digit timestamps have identical serialized byte widths, so this accounts for actual normalized entry JSON widths. Overshoot is at most one batch and is reported. A failed put may partially commit its internal transactions: failures explicitly mark byte accounting incomplete and report only completed-batch bytes plus a best-effort record count, rather than pretending to know the exact partial size.

Storage estimates are sampled before every dataset, after population (or at failure), and after cleanup. The reported usage delta is **approximate, origin-wide**, may include unrelated activity, and may reflect compression or index overhead. It is not exact physical DB bytes. Preflight skips when known available headroom is below `target * 1.35 + 64 MiB`. This conservative safety heuristic is not a cache-size cap or a guarantee against native quota/disk failure. Unavailable estimates are explicitly labeled and native failures remain catchable.

Metrics:

- Empty open/ready/count and populated reopen/ready/count milliseconds. Reopen is a new connection, not a cold OS disk cache.
- Populate wall seconds, records and logical bytes, with Worker generation/round-trip, normalization/byte accounting, and put-call breakdowns. These overlap where noted: Worker generation is inside round-trip; put includes rehash, validation and transactions. No metric is mislabeled pure I/O.
- `warm(target)` latest ≤2000 entries / ≤2 MiB, verifying returned bounds.
- 1000 sequential direct CacheStore indexed hits from a deterministic random reservoir, with different contexts from storage and exact source/text verification. 200 direct indexed misses. `performance.now()` timings include hashing/validation. Nearest-rank p50/p95 use the same sequential workload for each dataset.
- Hot in-memory Map get: 100000 operations, aggregate ms and approximate ns/get, including loop/key selection, excluding Map construction. This is explicitly separate from IndexedDB lookup timings.
- `deleteOldest(1000)` elapsed ms, independently verified 1000-record count drop and an oldest-insertion sample miss.
- Optional Chrome main-document JS heap is approximate and excludes the Worker; it is not a measurement of DB storage or retained cache memory.

Native quota/capacity and native storage-I/O errors are categorized separately from benchmark correctness errors; no arbitrary slowness threshold is imposed. Closing/crashing the document cannot guarantee cleanup: use Stop and wait. No persistent recovery list is written, and ownership is never guessed after reload.

## Node-only mock smoke test

PowerShell (does not open tabs or real IndexedDB):

```powershell
$env:BENCH_ROOT = 'ABSOLUTE_PATH_TO\tests\benchmark'
Get-Content -LiteralPath "$env:BENCH_ROOT\runner.mjs" -Raw | node --input-type=module --check
Get-Content -LiteralPath "$env:BENCH_ROOT\generator.worker.js" -Raw | node --input-type=commonjs --check
Get-Content -LiteralPath "$env:BENCH_ROOT\smoke.cjs" -Raw | node --input-type=commonjs
```

The smoke test syntax-checks sources, verifies generator determinism and protected numeric prefixes, then runs a VM copy of the runner with bounded mock DBs and smaller 6/15/21 MB payloads. It checks success, re-run, cancellation, quota failure, headroom skip and fallback cleanup. It does not change browser configs or claim actual browser timings. The real browser runner remains fixed at 200/500/700 MB.
