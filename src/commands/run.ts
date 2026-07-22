import { dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { correlate } from "../core/correlate.js";
import { sweep } from "../core/sweep.js";
import { getParser } from "../parsers/index.js";
import type { FlakeReport, RunResult } from "../types.js";
import { formatDuration } from "../utils/timing.js";

/**
 * `flaky run` — the pipeline conductor.
 *
 * PHASE 5 SCOPE: runs the command N times **sequentially** (rule #1), correlates
 * results across runs into `FlakeReport[]`, and prints a plain-text summary.
 * Phase 6 replaces that summary with the themed Xenolith table.
 *
 * Output discipline (rule #5, prep for `--json` in Phase 8): progress/logs go to
 * **stderr**; the final report is the tool's *result*, so it goes to **stdout**.
 */

export interface RunOptions {
  config?: string;
  /** Raw `-n/--times` value from commander (string); parsed + validated here. */
  times?: string;
}

/** Projected sweep time at or above which we warn the user (SPEC §6). */
const LARGE_SWEEP_MS = 5 * 60_000;

export async function runCommand(opts: RunOptions): Promise<void> {
  const configPath = opts.config ?? "./flaky.config.json";
  const absConfig = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(absConfig);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Resolve the parser up front so an unknown/unsupported reporter fails fast,
  // before we spend time running the suite.
  let parser: ReturnType<typeof getParser>;
  try {
    parser = getParser(config.reporter);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Resolve N: an explicit `-n/--times` overrides the config default.
  let times = config.times;
  if (opts.times !== undefined) {
    const parsed = Number(opts.times);
    if (!Number.isInteger(parsed) || parsed < 1) {
      process.stderr.write(`✗ --times must be a positive integer (got "${opts.times}").\n`);
      process.exitCode = 1;
      return;
    }
    times = parsed;
  }

  // Run the command where the user's project lives, so its command and
  // resultsPath resolve relative to the project — not to our CLI's cwd.
  const cwd = dirname(absConfig);

  const runs = await sweep({
    config,
    parser,
    times,
    cwd,
    onRunStart: (i, total) => {
      process.stderr.write(`⟁ Scanning specimen ${i}/${total} — ${config.command}\n`);
    },
    onRunComplete: ({ runIndex, total, run, elapsedMs }) => {
      process.stderr.write(`  ↳ ${describeRun(run)} — ${formatDuration(elapsedMs)}\n`);

      // First-run duration estimate + large-sweep warning (SPEC §6). Only worth
      // it when more runs remain.
      if (runIndex === 1 && total > 1) {
        const projected = elapsedMs * total;
        process.stderr.write(
          `⟁ Estimated sweep time: ~${formatDuration(projected)} (${total} runs).\n`,
        );
        if (projected >= LARGE_SWEEP_MS) {
          process.stderr.write(
            "⚠ This is a long sweep. Press Ctrl-C to abort, or re-run with a smaller --times.\n",
          );
        }
      }
    },
  });

  const usableRuns = runs.filter((r) => !r.crashed).length;
  const crashedRuns = runs.length - usableRuns;

  // Exit non-zero only when NO run yielded usable results (Decisions log
  // threshold). A report built from *surviving* runs still exits 0.
  if (usableRuns === 0) {
    const firstReason = runs.find((r) => r.crashReason)?.crashReason;
    const detail = firstReason ? ` First failure: ${firstReason}` : "";
    process.stderr.write(
      `✗ No usable runs — all ${runs.length} crashed. Nothing to report.${detail}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const reports = correlate(runs);
  renderSummary(reports, usableRuns, crashedRuns, runs.length);
}

/** One-line description of a single run, for the progress stream (stderr). */
function describeRun(run: RunResult): string {
  if (run.crashed) return `crashed — ${run.crashReason ?? "no usable results"}`;
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const r of run.results) {
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else skip++;
  }
  const timeout = run.timedOut ? " (timed out)" : "";
  return `exit ${run.runnerExitCode}${timeout}; ${run.results.length} tests (${pass} pass, ${fail} fail, ${skip} skip)`;
}

/**
 * Plain-text sweep summary → stdout (the tool's *result*). Phase 6 replaces this
 * with the themed `cli-table3` report; keeping it plain now means output is
 * already pipe-safe and stdout carries only the report.
 */
function renderSummary(
  reports: FlakeReport[],
  usableRuns: number,
  crashedRuns: number,
  totalRuns: number,
): void {
  const flaky = reports.filter((r) => r.classification === "flaky");
  const failing = reports.filter((r) => r.classification === "consistently-failing");
  const stable = reports.filter((r) => r.classification === "stable-pass");

  const lines: string[] = [];
  lines.push("");
  const crashNote = crashedRuns > 0 ? `, ${crashedRuns} crashed` : "";
  lines.push(`Sweep complete: ${usableRuns}/${totalRuns} runs usable${crashNote}.`);
  lines.push(
    `${reports.length} tests · ${flaky.length} flaky · ${failing.length} consistently-failing · ${stable.length} stable.`,
  );

  if (flaky.length > 0) {
    lines.push("");
    lines.push("⚠ Flaky anomalies (worst first):");
    for (const r of flaky) {
      lines.push(
        `  • ${r.testId} — ${r.fails}/${r.runs} fails (${Math.round(r.flakeRate * 100)}%)`,
      );
    }
  }
  if (failing.length > 0) {
    lines.push("");
    lines.push("✗ Consistently failing (likely real bugs, not flakes):");
    for (const r of failing) {
      lines.push(`  • ${r.testId} — ${r.fails}/${r.runs} fails`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}
