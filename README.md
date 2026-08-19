# flaky-test-detective

**Find the tests that lie.** A framework-agnostic CLI that runs your *existing* test
suite N times on unchanged code and correlates the results, so the tests that pass
sometimes and fail sometimes stop hiding in your CI history.

[![license](https://img.shields.io/badge/license-MIT-00F5D4)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-5EF38C)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/flaky-test-detective)](https://www.npmjs.com/package/flaky-test-detective)

```bash
npx flaky-test-detective init     # answer 5 questions
npx flaky-test-detective run -n 20
```

![flaky-test-detective running a sweep and reporting two flaky tests](./docs/demo.gif)

*One command. It runs your existing suite 8 times, finds the two tests that changed
their answer on unchanged code, and tells you which one is broken from the inside and
which one only breaks in company.*

---

## What it gives you

- **Names.** A ranked list of exactly which tests are unreliable, worst-first, with a
  measured flake rate — not a hunch, not "I think checkout is sometimes weird".
- **A direction to look.** `--isolate` splits every flake into *fails on its own*
  (randomness, timing, races) versus *fails only alongside other tests* (shared state,
  ordering). That's the difference between an hour of debugging and a day of it.
- **A separated bug list.** Tests failing 100% of the time are real bugs, not flakes, and
  get their own section instead of polluting the signal.
- **Something you can hand over.** `--html` for a self-contained report you can forward,
  `--json` for CI, `--pdf` for the people who ask for PDFs.

**Who it's for:** anyone whose CI has a "just re-run it" culture. Point it at your suite
before a release, on a nightly schedule, or the moment someone says "that test is flaky,
ignore it".

## Contents

[The problem](#the-problem) ·
[How it works](#how-it-works) ·
[Quickstart](#quickstart-30-seconds) ·
[What you get](#what-you-get) ·
[Diagnosis](#the-diagnosis-column---isolate) ·
[Exports](#exports) ·
[Commands](#command-reference) ·
[Limitations](#honest-limitations) ·
[Roadmap](#roadmap)

---

## The problem

A flaky test is one that returns different results on identical code. It costs you more
than a failure does, because a failure at least tells you something true:

- Someone re-runs the job. It goes green. The signal is gone and nothing was learned.
- The team learns that red doesn't mean broken, so eventually *real* red gets re-run too.
- The flake is invisible in any single CI run — the only evidence is in the aggregate,
  which nobody looks at.

You can't fix what you can't name. This tool names them, ranks them worst-first, and
tells you *which kind* of flaky each one is.

## How it works

It is **one layer above your test runner**, and it knows nothing about any test
framework:

```
flaky ──spawns──▶ your test command ──runs──▶ your tests
   ▲                     │
   └─── reads JUnit XML ◀─┘          (repeat N times, sequentially)
```

You tell it your command once, in `flaky.config.json`. That's the whole
language-agnostic mechanism — nothing about Jest, pytest, or `go test` is hardcoded, so
if your runner can write JUnit XML, this works. Across N runs each test is:

| Outcome | Verdict | Meaning |
|---|---|---|
| 100% pass | **stable** | nothing to see |
| 100% fail | **consistently-failing** | a real bug, not a flake — reported separately |
| a mix | **flaky** | the thing you came here for |

Runs are **strictly sequential, never parallel**. Parallel suite runs contend for the
same databases, ports and files, which manufactures flakiness — you'd be measuring your
own harness. (Your runner is still free to parallelize tests *inside* one run; that's
its job, not ours.)

## Quickstart (30 seconds)

**1. Make your runner write JUnit XML.** `flaky init` prints the exact flag for common
runners; some examples:

| Runner | Flag |
|---|---|
| Vitest | `vitest run --reporter=junit --outputFile.junit="{results}"` |
| Jest | `jest --reporters=jest-junit` (set `JEST_JUNIT_OUTPUT_PATH`) |
| pytest | `pytest --junitxml="{results}"` |
| Go | `gotestsum --junitfile "{results}"` |
| Mocha | `mocha --reporter mocha-junit-reporter` |

**2. Scaffold the config:**

```bash
npx flaky-test-detective init
```

```jsonc
{
  "command": "npx vitest run --outputFile.junit=\"{results}\"",  // your existing command
  "reporter": "junit",
  "resultsPath": "./reports/junit.xml",   // where your runner writes results
  "times": 20,                            // default N
  "timeoutMs": 300000,                    // per-run timeout
  "isolate": false,
  "isolationRuns": 10,
  // Optional — how to run ONE test alone (framework-specific syntax lives here):
  "isolateCommand": "npx vitest run {file} -t \"{testNamePattern}\" --outputFile.junit=\"{results}\""
}
```

> The `{results}` placeholder is the recommended setup: we substitute a **unique temp
> path per run**, so a crashed run can never be misread as the previous run's leftover
> success. Without it we fall back to `resultsPath`, pre-deleting it before each run.

**3. Sweep:**

```bash
npx flaky-test-detective run -n 20 --isolate
```

## What you get

On a terminal — the "Xenolith" view, worst-first:

```
╭─────────────────── specimen scan ───────────────────╮
│                                                     │
│   ⟁ Sweep complete · 20/20 runs usable              │
│   4 specimens · 2 anomalies · 1 broken · 1 stable   │
│                                                     │
╰─────────────────────────────────────────────────────╯

┌─────────────┬────────────────────────────────────────┬───────────┬───────────────┬───────────────┐
│ Verdict     │ Specimen                               │ Runs      │ Instability   │ Diagnosis     │
├─────────────┼────────────────────────────────────────┼───────────┼───────────────┼───────────────┤
│ ◈ ANOMALY   │ tests/checkout.spec.ts :: applies a    │ 13✓ 7✗    │ ▓▓░░░ 35%     │ ⚛ INTERNAL    │
│             │ discount code                          │           │               │               │
├─────────────┼────────────────────────────────────────┼───────────┼───────────────┼───────────────┤
│ ◈ ANOMALY   │ tests/session.spec.ts :: expires an    │ 17✓ 3✗    │ ▓░░░░ 15%     │ ⇄ ORDER       │
│             │ idle session                           │           │               │               │
├─────────────┼────────────────────────────────────────┼───────────┼───────────────┼───────────────┤
│ ✖ BROKEN    │ tests/billing.spec.ts :: refunds a     │ 0✓ 20✗    │ ▓▓▓▓▓ 100%    │ —             │
│             │ charge                                 │           │               │               │
├─────────────┼────────────────────────────────────────┼───────────┼───────────────┼───────────────┤
│ ✓ STABLE    │ tests/auth.spec.ts :: rejects a bad    │ 20✓ 0✗    │ ░░░░░ 0%      │ —             │
│             │ password                               │           │               │               │
└─────────────┴────────────────────────────────────────┴───────────┴───────────────┴───────────────┘

⇄ ORDER = fails only alongside other tests (shared state / ordering)  ·  ⚛ INTERNAL = fails on its own (randomness / timing)
```

Piped or redirected, the same report comes out as plain ANSI-free text, and every
progress line goes to stderr — so `flaky run > report.txt` gives you just the findings.

### The diagnosis column (`--isolate`)

Knowing a test is flaky doesn't tell you where to look. So `--isolate` re-runs each
flaky test **alone**, R times, and splits the causes in two:

- **⇄ ORDER — order / shared-state dependent.** It passed every single run alone, so it
  only fails in company: leaked global state, a shared fixture, a database row another
  test wrote, test-order coupling. Look *outside* the test.
- **⚛ INTERNAL — internally nondeterministic.** It fails on its own too: `Math.random`,
  `Date.now`, a race, a sleep-based wait, real network. Look *inside* the test.

One mechanism, two answers, and the honest third one (`? UNKNOWN`) when the filter
matched nothing rather than a guess.

## Exports

```bash
flaky run --json > flakes.json     # one versioned envelope on stdout, nothing else
flaky run --html report.html       # self-contained styled report, no external requests
flaky run --pdf report.pdf         # the same document through Chromium
```

- `--json` emits `{ schemaVersion, tool, generatedAt, sweep, isolation, counts, reports }`.
  The provenance matters: "0 anomalies from 20 clean runs" and "0 anomalies from 2 usable
  runs and 18 crashes" are the same headline and wildly different confidence, so the
  envelope carries both.
- `--html` is a single file with inline CSS and no network calls — forwardable, offline,
  identical in print.
- `--pdf` lazy-loads **puppeteer**, which is an *optional* peer dependency (Chromium is
  ~150MB, and you shouldn't pay for it unless you want PDFs). Without it installed you
  get a friendly hint and the HTML instead, not a failure. To enable: `npm i puppeteer`.

## Command reference

### `flaky init`

Interactively scaffolds `flaky.config.json`, including the reporter-flag cheat sheet for
your runner. Works non-interactively too (piped stdin answers the prompts in order), so
it's scriptable.

### `flaky run`

| Flag | Default | Purpose |
|---|---|---|
| `-n, --times <N>` | `20` | how many full-suite runs |
| `--isolate` | off | diagnose each flaky test by re-running it alone |
| `--no-isolate` | — | skip diagnosis even if the config enables it |
| `--isolation-runs <R>` | `10` | times to re-run each flaky test alone |
| `--json` | off | pure JSON on stdout (all logs → stderr) |
| `--html [path]` | off | write a styled HTML report |
| `--pdf [path]` | off | write a PDF report |
| `-c, --config <path>` | `./flaky.config.json` | config location |

**Exit codes:** `0` means we produced a report — *including* when it found flakes, because
this is a report, not a gate. Non-zero means we couldn't run: bad config, or no run
yielded usable results. (CI gating via `--fail-on-flake` is on the roadmap.)

Note that `--html`/`--pdf` paths resolve against the directory you're standing in, while
`resultsPath` resolves against the config's directory (that's where your test command
runs). Absolute paths sidestep the question.

**Ctrl-C** is safe at any point: it stops the spinner, restores your cursor, and kills the
spawned test process tree instead of orphaning your suite in the background.

## Honest limitations

- **We sample flakiness; we can never prove its absence.** 20 runs that find nothing
  means "no flake above roughly this rate", not "no flakes". Every report says so, and
  raising `--times` is the only way to tighten the bound.
- **A sweep costs N × your suite runtime.** It's a periodic whole-project sweep — run it
  locally when suspicious, or nightly/weekly in CI — not a per-PR gate.
- **`isolateCommand` is your runner's filter syntax, so exotic test names can need
  hand-tuning.** Use `{testNamePattern}` for regex-based filters (Vitest/Jest `-t`) and
  `{testName}` for substring matchers (pytest `-k`); names containing quotes, or a
  literal `%` on Windows, may still need adjusting.
- **A test that fails 100% of the time in-suite is reported as `consistently-failing`,
  not flaky** — even if it would pass alone. That's a real bug in the making, and it's
  listed separately rather than diluted into the flake list.
- **JUnit XML only, for now.** The parser sits behind a `ResultParser` adapter, so a
  native JSON reporter is a drop-in addition.
- **No telemetry.** It runs entirely locally and sends nothing anywhere.

## Roadmap

**V2** — order-randomization diagnosis (pinpoint the culprit, not just the victim); run
history and trends; a standalone `flaky report` regenerated from that history; targeted
mode (`--only`) that re-runs just the failures; `--fail-on-flake` for CI gating.

**V3** — a GitHub Action publishing a nightly sweep; quarantine-list export; monorepo
support.

## Development

```bash
npm install
npm run build         # tsup → dist/cli.js
npm test              # pure, hermetic suite (~1s)
npm run test:live     # spawns real test runs; needs the fixture installed
npm run lint          # biome
npm run typecheck
```

`fixtures/sample-project` is a deliberately unreliable Vitest suite (a coin flip, a
clock dependence, and an order-dependent victim) — you cannot build a flake detector
without flakes to detect. `fixtures/fake-runner` is a deterministic fake runner used by
the CLI integration tests, because asserting exact numbers against probabilistic flakes
would put a flaky test inside the flake detector.

Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Phase-by-phase build log:
[`docs/phases/`](./docs/phases).



## License

MIT © Aman Singh
