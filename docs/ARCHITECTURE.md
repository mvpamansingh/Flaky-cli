# Architecture

The **current** state of the system, as of Phase 9 (V1). Phase docs in
[`phases/`](./phases) are the historical log of *how it got here and why*; this file is
the single up-to-date reference for *how it works now*.

---

## 1. The mental model

We are **one layer above the test runner**, and we know nothing about any test framework.

```
flaky ──spawns──▶ user's test command ──runs──▶ their tests ──against──▶ their code
   ▲                       │
   └──── reads JUnit XML ◀──┘            (repeat N times, SEQUENTIALLY)
```

The user's `flaky.config.json` supplies the command. That indirection *is* the
language-agnostic mechanism: nothing about Jest, pytest, or `go test` is encoded anywhere
in `src/`, which is why a TypeScript tool can serve Python and Go projects.

A test is **flaky** when it produces different results across runs of unchanged code:
all-pass → `stable-pass`; all-fail → `consistently-failing` (a real bug, reported
separately); a mix → `flaky`. We can only ever *sample* flakiness, so every view prints
that caveat.

## 2. Module map

```
src/
├── cli.ts              entry point (shebang). Process-level policy ONLY: Node guard,
│                       signal handling, error boundary, exit codes, commander wiring.
├── version.ts          TOOL_NAME + TOOL_VERSION (one source for --version, exports, temp dir)
├── types.ts            domain types: Status, TestResult, RunResult, FlakeReport, RawRun
│
├── commands/           orchestration only — no detection or rendering logic
│   ├── init.ts         `flaky init`: interactive scaffold (+ reporter cheat sheet)
│   └── run.ts          `flaky run`: the pipeline conductor, and the ONLY place that
│                       decides what reaches stdout vs stderr
│
├── config/
│   ├── schema.ts       zod schema, `.strict()`, defaults mirroring the run flags
│   └── load.ts         find + read + validate; ConfigError with actionable messages
│
├── core/               the engine
│   ├── runner.ts       ONE run: spawn, per-run timeout + tree kill, unique temp file,
│   │                   crash detection. All subprocess/fs I/O lives here.
│   ├── sweep.ts        N runs sequentially → RunResult[]; owns `toRunResult`
│   ├── correlate.ts    RunResult[] → FlakeReport[] + classification. PURE.
│   └── isolate.ts      re-run one test alone R times → diagnosis
│
├── parsers/            the adapter seam that makes us framework-agnostic
│   ├── types.ts        ResultParser interface
│   ├── junit.ts        JUnit XML → TestResult[] (validates before parsing)
│   └── index.ts        getParser(reporter) registry
│
├── report/             presentation. Pure string-builders, except pdf.ts (spawns Chromium)
│   ├── types.ts        ReportMeta / ExportMeta / CrashInfo
│   ├── terminal.ts     themed cli-table3 + boxen, or plain pipe-safe text
│   ├── json.ts         versioned envelope
│   ├── html.ts         self-contained Xenolith document
│   └── pdf.ts          lazy, optional puppeteer
│
├── theme/              palette.ts (Xenolith hexes) · banner.ts (figlet + gradient)
└── utils/              leaves: tty.ts · tempfile.ts · timing.ts · outfile.ts
                        interrupt.ts (abort registry) · runtime.ts (Node guard)
```

### Dependency direction (load-bearing — keep it acyclic)

```
cli → commands → core → parsers / report
                   ↑
      types · theme · utils · version     (shared leaves — import nothing upward)
```

Two invariants worth defending in review:

1. **`core/correlate.ts` stays pure.** Data in, data out, no I/O. It's the heart of the
   product and must be trivially unit-testable. All I/O lives in `core/runner.ts`.
2. **Leaves never import upward.** This is why the Ctrl-C machinery is *inverted*:
   `utils/interrupt.ts` owns a registry, and `core`/`commands` register cleanups into it,
   rather than a util reaching into `core` to kill a process.

## 3. Data shapes

```ts
type Status = "pass" | "fail" | "skip";

interface TestResult { id; file; suite?; name; status: Status; durationMs?; }
//  id = `${file} :: ${suite} > ${name}`, collapsing to `${file} :: ${name}` with no suite

interface RawRun    { runIndex; startedAt; runnerExitCode; timedOut; crashed;
                      crashReason?; resultsPath; resultsXml?; }   // runner → parser seam
interface RunResult { runIndex; startedAt; results: TestResult[]; runnerExitCode;
                      crashed; crashReason?; timedOut; }

interface FlakeReport {
  testId; runs; passes; fails;      // `runs` = passes + fails (definitive outcomes only)
  flakeRate;                        // fails / (passes + fails) — skips excluded
  classification: "flaky" | "stable-pass" | "consistently-failing";
  diagnosis?: "order-dependent" | "internally-nondeterministic" | "unknown";
}
```

`RawRun` exists because the runner does I/O and cannot parse (the parser is a different
layer); the sweep turns `RawRun` → `RunResult`.

## 4. The pipeline

```
flaky run
  │
  ├─ cli.ts ......... Node ≥20 guard · install interrupt handler · parseAsync boundary
  │
  ├─ config/load .... zod-validated Config, or exit 1 with an actionable message
  ├─ parsers/index .. resolve the parser NOW, so a bad reporter fails before a long sweep
  ├─ resolve N, R, isolate tri-state, export paths ...... all validated BEFORE running
  │
  ├─ core/sweep ..... for i in 1..N  (awaited — never parallel)
  │     └─ core/runner ... unique temp path → spawn (shell, reject:false) → timeout
  │                        tree-kill → read+parse → crashed? keep it in the array
  │
  ├─ core/correlate . drop crashed runs → tally per testId → classify → sort worst-first
  │
  ├─ core/isolate ... (--isolate) for each FLAKY test: run it alone R times, sequentially,
  │                   match on file+name, ignore skips → diagnosis
  │
  ├─ report/terminal → stdout   (themed on a TTY, plain when piped)
  │  report/json     → stdout   (--json: this and nothing else)
  │  progress        → stderr   (ora spinner on a TTY, plain lines otherwise)
  │
  └─ report/html + report/pdf → files, announced on stderr
```

**Exit codes:** `0` = we produced a report (finding flakes *is* success — gating is V2's
`--fail-on-flake`). Non-zero = we couldn't run: config error, or zero usable runs. A sweep
with some crashed runs and ≥1 usable run still reports, and still exits 0.

## 5. Where each non-negotiable rule is enforced

| Rule | Enforced in | How |
|---|---|---|
| #1 Never run the N iterations in parallel | `core/sweep.ts`, `core/isolate.ts` | an awaited `for` loop; guarded by tests asserting exact progress ordering (L5, C3) |
| #2 A non-zero runner exit is DATA, not a crash | `core/runner.ts` (`reject:false`) | `crashed` is set only when no *usable results file* was produced; `parsers/junit.ts` validates XML first, so a corrupt file can't read as "0 tests, stable" |
| #3 Per-run timeout | `core/runner.ts` | our own timer + `killTree` (`taskkill /T /F` on Windows, negative-pid group signal on POSIX). execa's built-in `timeout` kills only the shell — measured a 500 ms timeout taking 10 s |
| #4 Unique results file per run | `utils/tempfile.ts` + `{results}` substitution | primary: `{results}` in the command → unique temp path. Fallback: `resultsPath`, pre-deleted so a crash can't read stale success. Third: `FLAKY_RESULTS_PATH` env, pointed at the same file we read |
| #5 Detect TTY; `--json` stdout is pure | `utils/tty.ts` + `commands/run.ts` | `isInteractive(stream)` gates **per stream** (`flaky run \| cat` leaves stderr a TTY); honors `NO_COLOR`; `--json` suppresses the spinner outright so zero ANSI reaches either stream |

Ctrl-C is the fifth rule's neighbour: `utils/interrupt.ts` stops the spinner (restoring the
cursor) and tree-kills the in-flight run, so aborting can't orphan the user's suite —
which would otherwise hold ports/DBs and manufacture flakiness in later runs.

## 6. Extension points

- **A new results format** → implement `ResultParser` in `parsers/`, register it in
  `parsers/index.ts`, add the name to the `reporter` enum in `config/schema.ts`. The
  engine doesn't change. (`json` is already reserved and throws an actionable
  "not supported yet".)
- **A new export** → a pure `render*(reports, meta)` string-builder in `report/`, plus a
  flag in `cli.ts` and a write in `run.ts`'s `writeExports`. Renderers never write to
  streams themselves; stream policy lives in exactly one place.
- **A new diagnosis** → `core/isolate.ts`'s `diagnose()` is pure and 3-way today; the
  `FlakeReport.diagnosis` union and `report/terminal.ts`'s label map are the two places a
  fourth verdict would touch.
- **CI gating** → `--fail-on-flake` reads `counts.flaky` from the JSON envelope's shape;
  the envelope is versioned (`schemaVersion: 1`) precisely so it's safe to build on.

## 7. Testing strategy

Two suites, split by *config* rather than by convention, so the constraint is structural:

- **`npm test`** (`vitest.config.ts`) — pure and hermetic: ~107 tests, ~4 s, no
  subprocesses, no `dist/`, no fixture install. Excludes `*.live.test.ts`.
- **`npm run test:live`** (`vitest.live.config.ts`) — spawns real processes: 34 tests,
  ~60 s. `fileParallelism: false` + `singleFork`, because two live files spawning suite
  runs concurrently would contend for the fixture's `reports/` dir and manufacture
  flakiness *in our own suite* — rule #1's reasoning applied to our harness.

Two fixtures, for two different jobs:

- **`fixtures/sample-project`** — a real Vitest suite that is genuinely unreliable (coin
  flip, clock dependence, order-dependent victim). Proves the tool works against an
  actual runner. Its flakes are probabilistic, so tests against it assert *shape*, not
  exact numbers.
- **`fixtures/fake-runner`** — not a test framework at all: a script that writes JUnit XML
  on a fixed schedule. Lets the CLI tests assert exact reports without putting a flaky
  test inside the flake detector, and makes `order-dependent` reachable end-to-end
  (a test that passes alone but fails in company).

Still human-verified: the themed TTY view. Every automated test pipes stdout, which by
rule #5 means the plain renderer runs.
