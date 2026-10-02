# Eval timing benchmark

Run from the repository root after installing dependencies and building both
checkouts:

```sh
bun run --cwd packages/senpi-codemode bench -- --base /path/to/base --head /path/to/head --blocks 3 --reps 15 --out bench-report.json
```

The defaults (3 blocks x 15 repetitions = 45 adjacent pairs per row) take about 2.5 hours
for the five-runtime matrix; most of that is the fixed-clock detach, interrupt and
Julia output workloads.

Both targets run on the same machine, with five unmeasured warm-up cells.
Each runtime has four isolated retained host processes: base, head, and two
independent base instances for calibration. Only one receives a measurement
request at a time. Each scenario first rehearses once without retaining a
sample, then measures `--reps` repetitions per side. Repetitions are paired
adjacently, reversing both comparison and calibration order across repetitions
and blocks; an entire scenario suite never separates a pair.
Cold-start trials use fresh kernels and have no discarded scenario rehearsal.
A separate A/A calibration runs in the same invocation.

## Estimator and thresholds

Host noise on a shared machine is time-correlated: two adjacent repetitions move
together, while per-side minima taken from different moments do not. Each row
(runtime x scenario x CPU/wall/p95) is therefore judged on its adjacent pairs:
the gated statistic is the 25% trimmed mean of the paired log ratios across all
blocks and repetitions (`bench-stats.ts`).

Every row gets its threshold from its own calibration pairs through one rule,
`rowNoiseBand` in `bench-threshold.ts`: band = |A/A trimmed-mean offset| +
`THRESHOLD_Z` (4) standard errors of that trimmed mean. Only the constant differs
between rows; the rule is the same for all of them. The threshold is the band
capped at `MAX_BAND` (0.05). A row FAILs when its paired ratio exceeds
`1 + band`. A row whose band is above 0.05 is NOISE-LIMITED: it can still fail
beyond its own noise, but it never passes, and the run is INCONCLUSIVE. The
report prints threshold, band, ratio, median paired ratio and verdict per row.

`--band-scope global` switches to one band for every row (the 95th percentile
over rows of the A/A trimmed-mean deviation) with the same estimator, cap and
verdicts. It is the only knob between the two policies.

Exit codes: 0 PASS, 1 regression, 2 refused (load above 80 or stale build),
3 INCONCLUSIVE (missing runtime/scenario/sample, version mismatch, unavailable
accounting, failed workload, or a noise-limited row). The report retains individual
samples, observations, actual measurement ordering, block-start/block-end load,
per-repetition start/end load, power source, and runtime versions.
RSS and wall time remain load-dependent measurements.

## CPU accounting

The host's `process.cpuUsage()` already includes its JavaScript worker threads.
No thread total is added to it. Subprocess kernels report their own cumulative
CPU through ordinary cells. The benchmark overrides only the interpreter command
using the existing detected-interpreter option; production source is untouched.
A dependency-free Python launcher preserves the interpreter's transport and kill
group. A collector in a separate process group records POSIX `wait4` usage even
when the host force-kills the entire kernel group. Python's PID-directed signals
are forwarded; Ruby and Julia retain their existing group-directed signals.

Snapshots are joined by PID. For an interpreter that dies during the window,
its final receipt minus its starting snapshot contributes alongside the replacement's
CPU. Missing final usage invalidates the run; it is never reported as zero.
Receipt creation is atomic; the waiter then connects to a Unix socket the collector
listens on before any kernel starts (directory watchers subscribe asynchronously on
macOS and can miss an early receipt);
missing receipts have a bounded watchdog. The launcher and collector are benchmark
infrastructure and their own CPU is excluded.
Windows lacks this waiter and is explicitly unsupported for full process accounting.

The detach wall interval ends when eval returns its detached handle. Its CPU
interval additionally includes cancellation and the following scalar readiness
cell, since a sleeping interpreter cannot run a transport probe concurrently.
Interrupt CPU likewise includes the terminal probe and any replacement startup.
These scopes are identical on both sides and recorded separately from wall time.

Python's current `print` implementation buffers a whole cell into one frame.
The streamed-output and interrupt-readiness fixtures therefore use the existing
prelude `text` emitter: this measures bounded stdout frames and supplies a signal
while the cell is running, rather than after its buffered output is released.
Julia uses its prelude's synchronous `print`, not the file-tool helper named
`write` or the asynchronously forwarded Base `println`. Its GC fixture uses a
Julia-owned byte vector with native `memset`, matching the other languages'
native bulk fills rather than measuring an interpreted element-by-element loop.
The GC scenario gets a fresh kernel with the existing 150 MiB test's 32 MiB
watermark, 64 MiB notice threshold, and disabled ceiling. JavaScript uses the
existing constructor's `onMemoryCollected` callback and waits for native idle
collection, matching the repository's memory test without sleeps. Its count
includes cell-reported and observed idle collections. Subprocess counts are
cell-reported policy collections; `forcedCollections` separately records the
explicit collection before their final live-memory observation.

The crash workload reports current behavior, including failed queued cells on
fail-closed runtimes; it does not pretend to implement later kernel recovery.
It records executions, generations, replacements, settled entries, and remaining
children. Existing runtime memory reports can be unavailable; missing memory
observations are `null`, not zero.

## Controlled checks

`--runtimes js-bun,js-node,py` explicitly selects a subset for diagnosis; such a
report does not establish the full five-runtime gate. Unknown or empty selections
are rejected. The default manifest requires Bun, Node, Python, Ruby, and Julia.
Only explicitly optional features introduced by later plan nodes are recorded
as not present on head when absent on both targets. A missing required workload
is inconclusive even when both sides omit it.

`--inject-slow head:warm-cell-1000:1.3` scales only that workload's head comparison
samples after measurement. It is a comparator fault injection, not a CPU burner.
`--inject-loadavg 81` exercises refusal without starting a workload.
