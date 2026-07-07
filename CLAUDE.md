# CLAUDE.md — Read this first, every session

You are helping build **Flaky-test Detective**, a framework-agnostic CLI that finds
unreliable ("flaky") tests by running an existing test suite many times and correlating
the results. This file is the anchor. **Before doing anything else in a session, read
`PROGRESS.md`** to see current state, decisions, and the next action. Update `PROGRESS.md`
at the end of every session.

## The one-sentence mental model
Our CLI **does not run tests itself and knows nothing about any test framework.** It shells
out to the user's *existing* test command (`npm test`, `pytest`, `go test`, …), runs it N
times, reads structured results, and correlates. We are one layer *above* the test runner.
This is why it is language-agnostic and why TypeScript is a perfectly good choice.

## What "flaky" means
A test that returns different results on identical code. Across N runs:
- 100% pass  → **stable**
- 100% fail  → **consistently-failing** (a real bug, not flaky — surface separately)
- mix        → **flaky** (our target)

We can only *sample* flakiness, never prove its absence. The output is a statistical
statement, not a guarantee. Say so honestly in the UI.

## Aesthetic: "Xenolith" — futuristic / bioluminescent alien vibe
Coherent theme language: tests are *specimens*, flakes are *anomalies / unstable signals*.
Full palette + fonts in `SPEC.md → Aesthetic`. Keep it beautiful but never sacrifice
readability or break when output is piped (non-TTY → plain text).

## Tech stack (locked for V1)
- Node 20+, **TypeScript**, **ESM** (`"type": "module"`)
- CLI: `commander` · Subprocess: `execa` (ESM-only, use latest)
- Parse: `fast-xml-parser` (JUnit XML), native JSON
- Config validation: `zod`
- Output: `chalk` + `gradient-string` + `figlet` + `cli-table3` + `ora` + `boxen`
- Export: styled HTML (template literal + themed CSS), PDF via `puppeteer` (lazy-loaded)
- Build: `tsup` · Lint/format: `biome` · Test our own tool: `vitest`
- Distribute: npm, run via `npx`

## Non-negotiable rules (these are load-bearing correctness decisions)
1. **Never run the N iterations in parallel.** Parallel suite runs contend for DB/ports/files
   and *manufacture* flakiness. Runs are sequential. (The runner parallelizes tests *inside*
   one run — that's its job, not ours.)
2. **A non-zero exit code from the runner is expected data, not a crash.** Failing tests make
   runners exit non-zero. Distinguish "ran, some tests failed" (parse results) from "runner
   itself blew up / no results file" (real error).
3. **Per-run timeout** so one hung run can't freeze the whole sweep.
4. **Write results to a unique temp file per run**, read it immediately, then next run — never
   rely on a single overwritten path (stale-read race).
5. **Detect TTY.** No colors/spinners when piped or in `--json` mode. In `--json`, stdout is
   pure JSON; all logs go to stderr.

## Session protocol (prevents context loss)
1. Read `PROGRESS.md` → find **Next action**.
2. Do that one thing. Keep changes runnable at each step.
3. Before ending: update the checklist, append to **Decisions log** (what + why), and set the
   new **Next action**. Never leave the repo in a broken state without noting it.

## Docs map
- `SPEC.md` — full spec: features, commands, config schema, data shapes, run-loop, roadmap.
- `PROGRESS.md` — living state: checklist, decisions log, next action, session notes.
