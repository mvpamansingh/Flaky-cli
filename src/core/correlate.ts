import type { FlakeReport, RunResult } from "../types.js";

/**
 * Correlate `RunResult[]` → `FlakeReport[]`. This is the heart of the tool.
 *
 * **PURE**: data in, data out — no I/O, no clock, no randomness — so it's
 * trivially unit-testable (SPEC §11 keeps this module free of side effects).
 *
 * Only NON-crashed runs contribute: a crashed run produced no usable results, so
 * counting it would corrupt aggregation. For each `testId` we tally definitive
 * outcomes (pass / fail) across those runs; a `skip` carries no flakiness signal,
 * so it's excluded from the denominator (`runs = passes + fails`).
 *
 * Classification follows CLAUDE.md's definition of "flaky" — different results on
 * identical code:
 *   - some pass AND some fail → `flaky`                (our target)
 *   - zero pass, some fail    → `consistently-failing` (a real bug — surfaced separately)
 *   - otherwise               → `stable-pass`          (all definitive outcomes passed;
 *                                                        also covers never-ran / all-skip)
 *
 * We can only *sample* flakiness across the runs we observed — the output is a
 * statistical statement, never a proof of absence.
 */
export function correlate(runs: RunResult[]): FlakeReport[] {
  const usable = runs.filter((r) => !r.crashed);

  // Tally per stable test id across all usable runs.
  const tallies = new Map<string, { passes: number; fails: number; skips: number }>();
  for (const run of usable) {
    for (const t of run.results) {
      let tally = tallies.get(t.id);
      if (!tally) {
        tally = { passes: 0, fails: 0, skips: 0 };
        tallies.set(t.id, tally);
      }
      if (t.status === "pass") tally.passes++;
      else if (t.status === "fail") tally.fails++;
      else tally.skips++;
    }
  }

  const reports: FlakeReport[] = [];
  for (const [testId, { passes, fails }] of tallies) {
    const definitiveRuns = passes + fails;
    const flakeRate = definitiveRuns > 0 ? fails / definitiveRuns : 0;

    let classification: FlakeReport["classification"];
    if (passes > 0 && fails > 0) classification = "flaky";
    else if (fails > 0) classification = "consistently-failing";
    else classification = "stable-pass";

    reports.push({ testId, runs: definitiveRuns, passes, fails, flakeRate, classification });
  }

  reports.sort(worstFirst);
  return reports;
}

/** Rank for worst-first ordering: anomalies before bugs before stable specimens. */
const CLASS_RANK: Record<FlakeReport["classification"], number> = {
  flaky: 0,
  "consistently-failing": 1,
  "stable-pass": 2,
};

/**
 * Deterministic worst-first comparator: flaky → consistently-failing →
 * stable-pass; within a class, higher flake rate first; ties broken by testId so
 * the ordering is stable regardless of run order (keeps the pure fn reproducible).
 */
function worstFirst(a: FlakeReport, b: FlakeReport): number {
  if (CLASS_RANK[a.classification] !== CLASS_RANK[b.classification]) {
    return CLASS_RANK[a.classification] - CLASS_RANK[b.classification];
  }
  if (b.flakeRate !== a.flakeRate) return b.flakeRate - a.flakeRate;
  return a.testId.localeCompare(b.testId);
}
