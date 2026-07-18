/**
 * Shared domain types — the normalized shapes every layer speaks in.
 *
 * These are the "extensibility backbone" (SPEC §5): parsers produce `TestResult[]`,
 * the sweep produces `RunResult[]`, and correlation produces `FlakeReport[]`. Keeping
 * them here (a leaf module that imports nothing upward) is what lets the pure core,
 * the parsers, and the report layer agree without depending on each other.
 */

/** Outcome of a single test within a single run. */
export type Status = "pass" | "fail" | "skip";

/** One test's result in one run, normalized away from any runner's format. */
export interface TestResult {
  /** Stable identity across runs: `${file} :: ${suite} > ${name}`. */
  id: string;
  file: string;
  suite?: string;
  name: string;
  status: Status;
  durationMs?: number;
}

/**
 * The fully-parsed result of one full-suite run.
 *
 * `crashed` means the RUNNER itself blew up (no/invalid results file) — NOT that
 * some tests failed. A non-zero `runnerExitCode` with a valid results file is
 * normal, expected data (CLAUDE.md rule #2).
 */
export interface RunResult {
  runIndex: number;
  /** ISO timestamp of when this run started. */
  startedAt: string;
  results: TestResult[];
  runnerExitCode: number;
  /** true = runner failed to produce usable results, NOT test failures. */
  crashed: boolean;
  timedOut: boolean;
}

/** Per-test verdict after correlating all runs — the tool's headline output. */
export interface FlakeReport {
  testId: string;
  runs: number;
  passes: number;
  fails: number;
  /** fails/runs — only meaningful when 0 < fails < runs. */
  flakeRate: number;
  classification: "flaky" | "stable-pass" | "consistently-failing";
  diagnosis?: "order-dependent" | "internally-nondeterministic" | "unknown";
}

/**
 * The raw output of executing ONE run, BEFORE parsing (Phase 3 → Phase 4 seam).
 *
 * `core/runner.ts` does I/O only: spawn, timeout, capture exit code, and decide
 * whether the runner produced a usable results file. It deliberately does NOT
 * parse — that's the `parsers/` layer. Phase 4/5 turn `resultsXml` into
 * `TestResult[]` and assemble the full {@link RunResult}.
 */
export interface RawRun {
  runIndex: number;
  startedAt: string;
  runnerExitCode: number;
  timedOut: boolean;
  /** true = no usable results file (runner blew up), NOT test failures. */
  crashed: boolean;
  /** Human-readable reason we classified this run as crashed, if it was. */
  crashReason?: string;
  /** Absolute path where we expected (and tried to read) the results file. */
  resultsPath: string;
  /** Raw results-file contents when the runner produced a non-empty file. */
  resultsXml?: string;
}
