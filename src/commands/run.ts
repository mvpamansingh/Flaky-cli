import { dirname, isAbsolute, resolve } from "node:path";
import ora, { type Ora } from "ora";
import { loadConfig } from "../config/load.js";
import { correlate } from "../core/correlate.js";
import { sweep } from "../core/sweep.js";
import { getParser } from "../parsers/index.js";
import { renderReport } from "../report/terminal.js";
import type { RunResult } from "../types.js";
import { formatDuration } from "../utils/timing.js";
import { isInteractive } from "../utils/tty.js";

/**
 * `flaky run` — the pipeline conductor. Orchestration only: it drives
 * `core` (sweep → correlate) then hands the result to `report`; it holds no
 * detection or rendering logic of its own (SPEC §11 dependency direction).
 *
 * Output discipline (rule #5, prep for `--json` in Phase 8): progress goes to
 * **stderr** (an `ora` spinner on a TTY, plain lines when piped); the final
 * report is the tool's *result*, so it goes to **stdout** (themed on a TTY,
 * plain pipe-safe text otherwise). The two streams are gated independently via
 * `isInteractive` because they can differ (e.g. `flaky run | cat` leaves stderr
 * a TTY but stdout a pipe).
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

  // Progress → stderr. A live spinner on an interactive stderr (rule #5), plain
  // lines when piped. `ora` writes to stderr so it never pollutes the stdout report.
  const spinner: Ora | undefined = isInteractive(process.stderr)
    ? ora({ stream: process.stderr, text: "⟁ Preparing specimen scan…" }).start()
    : undefined;

  const runs = await sweep({
    config,
    parser,
    times,
    cwd,
    onRunStart: (i, total) => {
      if (spinner) spinner.text = `⟁ Scanning specimen ${i}/${total}…`;
      else process.stderr.write(`⟁ Scanning specimen ${i}/${total} — ${config.command}\n`);
    },
    onRunComplete: ({ runIndex, total, run, elapsedMs }) => {
      // The per-run breakdown scrolls past on a TTY (the spinner already shows
      // live progress), so only emit it when piped.
      if (!spinner) {
        process.stderr.write(`  ↳ ${describeRun(run)} — ${formatDuration(elapsedMs)}\n`);
      }

      // First-run duration estimate + large-sweep warning (SPEC §6). Only worth
      // it when more runs remain. Persist above the spinner (`.info`/`.warn`
      // stop it and print a line), then resume the scan.
      if (runIndex === 1 && total > 1) {
        const projected = elapsedMs * total;
        const est = `⟁ Estimated sweep time: ~${formatDuration(projected)} (${total} runs).`;
        if (spinner) spinner.info(est).start();
        else process.stderr.write(`${est}\n`);

        if (projected >= LARGE_SWEEP_MS) {
          const warn =
            "⚠ This is a long sweep. Press Ctrl-C to abort, or re-run with a smaller --times.";
          if (spinner) spinner.warn(warn).start();
          else process.stderr.write(`${warn}\n`);
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
    const msg = `✗ No usable runs — all ${runs.length} crashed. Nothing to report.${detail}`;
    if (spinner) spinner.fail(msg);
    else process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
    return;
  }

  spinner?.succeed(`⟁ Scan complete — ${usableRuns}/${runs.length} runs usable.`);

  const reports = correlate(runs);
  const report = renderReport(
    reports,
    { usableRuns, crashedRuns, totalRuns: runs.length },
    { color: isInteractive(process.stdout) },
  );
  process.stdout.write(report);
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
