import { performance } from "node:perf_hooks";
import type { Config } from "../config/schema.js";
import type { ResultParser } from "../parsers/index.js";
import type { RawRun, RunResult } from "../types.js";
import { runOnce } from "./runner.js";

/**
 * The N-times sweep — the loop at the center of the tool.
 *
 * Runs the user's test command `times` times **sequentially** (CLAUDE.md rule #1:
 * concurrent suite runs contend for DB/ports/files and *manufacture* the very
 * flakiness we're trying to measure). Each raw run is parsed into a normalized
 * {@link RunResult} via the shared {@link toRunResult} path.
 *
 * A crashed run (runner blew up / unparseable results) is KEPT in the returned
 * array — with empty `results` — so callers can report how many runs failed;
 * `core/correlate.ts` ignores crashed runs, so one never corrupts aggregation.
 */

/** Progress reported after each run completes. */
export interface SweepProgress {
  runIndex: number;
  total: number;
  run: RunResult;
  /** Wall-clock time this run took, including our small orchestration overhead. */
  elapsedMs: number;
}

export interface SweepOptions {
  config: Config;
  /** Resolved reporter adapter (caller resolves it up front to fail fast). */
  parser: ResultParser;
  /** Number of sequential runs. Caller resolves `-n/--times` vs `config.times`. */
  times: number;
  /** Directory to run in (the user's project — dir of the config file). */
  cwd?: string;
  /** Fired just before each run starts, for a progress line. */
  onRunStart?: (runIndex: number, total: number) => void;
  /** Fired after each run is parsed, with timing. */
  onRunComplete?: (progress: SweepProgress) => void;
}

export async function sweep({
  config,
  parser,
  times,
  cwd,
  onRunStart,
  onRunComplete,
}: SweepOptions): Promise<RunResult[]> {
  const runs: RunResult[] = [];
  // SEQUENTIAL by construction: each iteration awaits the previous run fully
  // before the next starts. Do NOT parallelize this (rule #1).
  for (let runIndex = 1; runIndex <= times; runIndex++) {
    onRunStart?.(runIndex, times);
    const start = performance.now();
    const raw = await runOnce({ config, runIndex, cwd });
    const elapsedMs = performance.now() - start;
    const run = toRunResult(raw, parser);
    runs.push(run);
    onRunComplete?.({ runIndex, total: times, run, elapsedMs });
  }
  return runs;
}

/**
 * Turn a raw (unparsed) run into a fully-parsed {@link RunResult}.
 *
 * Lifted here from `commands/run.ts` so the sweep loop and future single-run
 * callers (Phase 7 isolation) share ONE "parse, unparseable = crashed" path.
 *
 * A run the runner already flagged as crashed stays crashed. Otherwise we parse
 * `resultsXml`; if parsing throws, the file is unparseable — which SPEC §6 treats
 * as a crashed run (the runner produced *something*, but not usable results),
 * NOT as a run where tests merely failed (rule #2).
 */
export function toRunResult(raw: RawRun, parser: ResultParser): RunResult {
  const base = {
    runIndex: raw.runIndex,
    startedAt: raw.startedAt,
    runnerExitCode: raw.runnerExitCode,
    timedOut: raw.timedOut,
  };
  if (raw.crashed) {
    return { ...base, results: [], crashed: true, crashReason: raw.crashReason };
  }
  try {
    const results = parser.parse(raw.resultsXml ?? "");
    return { ...base, results, crashed: false };
  } catch (err) {
    return {
      ...base,
      results: [],
      crashed: true,
      crashReason: `Could not parse results at ${raw.resultsPath}: ${(err as Error).message}`,
    };
  }
}
