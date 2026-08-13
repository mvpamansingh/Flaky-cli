import { dirname, isAbsolute, resolve } from "node:path";
import ora, { type Ora } from "ora";
import { loadConfig } from "../config/load.js";
import { correlate } from "../core/correlate.js";
import { type TestIdentity, isolate } from "../core/isolate.js";
import { sweep } from "../core/sweep.js";
import { getParser } from "../parsers/index.js";
import { renderReport } from "../report/terminal.js";
import type { FlakeReport, RunResult } from "../types.js";
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
  /** `--isolate` flag; when absent, falls back to `config.isolate`. */
  isolate?: boolean;
  /** Raw `--isolation-runs` value (string); parsed + validated here. */
  isolationRuns?: string;
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
  const times = resolvePositiveInt(opts.times, config.times, "--times");
  if (times === undefined) {
    process.stderr.write(`✗ --times must be a positive integer (got "${opts.times}").\n`);
    process.exitCode = 1;
    return;
  }

  // Resolve isolation: `--isolate` flag overrides `config.isolate`; `-R` count
  // overrides `config.isolationRuns`.
  const isolateEnabled = opts.isolate ?? config.isolate;
  const isolationRuns = resolvePositiveInt(
    opts.isolationRuns,
    config.isolationRuns,
    "--isolation-runs",
  );
  if (isolationRuns === undefined) {
    process.stderr.write(
      `✗ --isolation-runs must be a positive integer (got "${opts.isolationRuns}").\n`,
    );
    process.exitCode = 1;
    return;
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

  // Isolation diagnosis (Phase 7): re-run each flaky test alone R times to tell
  // an external cause (order / shared state) from an internal one (randomness /
  // timing). Only the `flaky` rows are worth isolating.
  if (isolateEnabled) {
    await diagnoseFlaky(reports, runs, {
      config,
      parser,
      cwd,
      isolationRuns,
      spinner,
    });
  }

  const report = renderReport(
    reports,
    { usableRuns, crashedRuns, totalRuns: runs.length },
    { color: isInteractive(process.stdout) },
  );
  process.stdout.write(report);
}

/**
 * Parse an optional `--flag` override into a positive int, else the config
 * default. Returns `undefined` when an override was given but is invalid (the
 * caller prints the flag-specific error and exits).
 */
function resolvePositiveInt(
  override: string | undefined,
  fallback: number,
  _flag: string,
): number | undefined {
  if (override === undefined) return fallback;
  const parsed = Number(override);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/**
 * Run isolation diagnosis over the `flaky` reports and attach each `diagnosis`
 * back onto its report (mutates `reports` in place). No-ops with a friendly
 * stderr note when there's nothing to isolate or no `isolateCommand` configured
 * — isolation is a bonus pass, never a hard failure.
 */
async function diagnoseFlaky(
  reports: FlakeReport[],
  runs: RunResult[],
  ctx: {
    config: Awaited<ReturnType<typeof loadConfig>>;
    parser: ReturnType<typeof getParser>;
    cwd: string;
    isolationRuns: number;
    spinner: Ora | undefined;
  },
): Promise<void> {
  const { config, parser, cwd, isolationRuns, spinner } = ctx;
  const flaky = reports.filter((r) => r.classification === "flaky");

  const note = (msg: string) => {
    if (spinner) spinner.info(msg);
    else process.stderr.write(`${msg}\n`);
  };

  if (flaky.length === 0) {
    note("⟁ No flaky anomalies to isolate.");
    return;
  }
  if (!config.isolateCommand) {
    note(
      '⚠ --isolate needs an `isolateCommand` in your config (e.g. "npx vitest run {file} -t \\"{testNamePattern}\\""). Skipping diagnosis.',
    );
    return;
  }

  // Recover each flaky test's file + name from the sweep results (correlate only
  // keeps the id). Match on file + name during isolation (SPEC §4).
  const identities = buildIdentityMap(runs);
  const targets: TestIdentity[] = [];
  for (const r of flaky) {
    const id = identities.get(r.testId);
    if (id) targets.push(id);
  }

  if (spinner) spinner.start(`⟁ Isolating ${targets.length} anomalies…`);
  else
    process.stderr.write(`⟁ Isolating ${targets.length} anomalies (${isolationRuns} runs each)…\n`);

  const isoResults = await isolate({
    config,
    parser,
    targets,
    isolationRuns,
    cwd,
    onProgress: ({ name, run, totalRuns, targetIndex, totalTargets }) => {
      const text = `⟁ Isolating ${name} — run ${run}/${totalRuns} (${targetIndex}/${totalTargets})…`;
      if (spinner) spinner.text = text;
      else process.stderr.write(`  ↳ ${text}\n`);
    },
  });

  const byId = new Map(isoResults.map((x) => [x.testId, x.diagnosis]));
  for (const r of reports) {
    const diagnosis = byId.get(r.testId);
    if (diagnosis) r.diagnosis = diagnosis;
  }

  spinner?.succeed(
    `⟁ Isolation complete — diagnosed ${targets.length} anomal${targets.length === 1 ? "y" : "ies"}.`,
  );
}

/** Map each test's stable id → its file/name (first occurrence across all runs). */
function buildIdentityMap(runs: RunResult[]): Map<string, TestIdentity> {
  const map = new Map<string, TestIdentity>();
  for (const run of runs) {
    for (const t of run.results) {
      if (!map.has(t.id)) map.set(t.id, { testId: t.id, file: t.file, name: t.name });
    }
  }
  return map;
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
