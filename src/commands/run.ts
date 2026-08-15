import { dirname, isAbsolute, resolve } from "node:path";
import ora, { type Ora } from "ora";
import { loadConfig } from "../config/load.js";
import { correlate } from "../core/correlate.js";
import { type TestIdentity, isolate } from "../core/isolate.js";
import { sweep } from "../core/sweep.js";
import { getParser } from "../parsers/index.js";
import { renderHtml } from "../report/html.js";
import { renderJson } from "../report/json.js";
import { htmlFallbackPath, writePdfReport } from "../report/pdf.js";
import { renderReport } from "../report/terminal.js";
import type { ExportMeta } from "../report/types.js";
import type { FlakeReport, RunResult } from "../types.js";
import { onInterrupt } from "../utils/interrupt.js";
import { writeOutputFile } from "../utils/outfile.js";
import { formatDuration } from "../utils/timing.js";
import { isInteractive } from "../utils/tty.js";

/**
 * `flaky run` — the pipeline conductor. Orchestration only: it drives
 * `core` (sweep → correlate) then hands the result to `report`; it holds no
 * detection or rendering logic of its own (SPEC §11 dependency direction).
 *
 * Output discipline (rule #5): progress goes to **stderr** (an `ora` spinner on a
 * TTY, plain lines when piped); the final report is the tool's *result*, so it goes
 * to **stdout** (themed on a TTY, plain pipe-safe text otherwise). The two streams
 * are gated independently via `isInteractive` because they can differ (e.g.
 * `flaky run | cat` leaves stderr a TTY but stdout a pipe).
 *
 * `--json` (Phase 8) tightens that contract: stdout carries NOTHING but the JSON
 * envelope, the spinner is suppressed outright (a spinner writing to stderr is
 * still ANSI noise a CI log doesn't want), and every human-facing line — progress,
 * export notices, warnings — goes to stderr. Export flags (`--html`/`--pdf`) write
 * files and announce themselves on stderr too, never on stdout.
 */

export interface RunOptions {
  config?: string;
  /** Raw `-n/--times` value from commander (string); parsed + validated here. */
  times?: string;
  /**
   * Tri-state isolation switch: `true` = `--isolate`, `false` = `--no-isolate`,
   * `undefined` = neither flag given → fall back to `config.isolate`.
   */
  isolate?: boolean;
  /** Raw `--isolation-runs` value (string); parsed + validated here. */
  isolationRuns?: string;
  /** `--json`: stdout becomes a pure JSON envelope; all logs → stderr (rule #5). */
  json?: boolean;
  /** `--html [path]`: `true` = default filename, string = explicit path. */
  html?: string | boolean;
  /** `--pdf [path]`: `true` = default filename, string = explicit path. */
  pdf?: string | boolean;
}

/** Projected sweep time at or above which we warn the user (SPEC §6). */
const LARGE_SWEEP_MS = 5 * 60_000;

/** Filenames used when `--html`/`--pdf` are passed without a path. */
const DEFAULT_HTML_NAME = "flaky-report.html";
const DEFAULT_PDF_NAME = "flaky-report.pdf";

export async function runCommand(opts: RunOptions): Promise<void> {
  const json = opts.json === true;
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

  // Resolve isolation. `??` (not `||`) is what makes the escape hatch work:
  // `--no-isolate` gives `false`, which must beat a config `"isolate": true`,
  // while "neither flag passed" is `undefined` and defers to the config.
  const isolateEnabled = resolveIsolate(opts.isolate, config.isolate);
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

  // Resolve export destinations BEFORE the sweep: a bad path should fail in
  // milliseconds, not after twenty runs of someone's integration suite.
  const htmlTarget = resolveExportPath(opts.html, DEFAULT_HTML_NAME, "--html");
  const pdfTarget = resolveExportPath(opts.pdf, DEFAULT_PDF_NAME, "--pdf");
  const pathError = htmlTarget.error ?? pdfTarget.error;
  if (pathError) {
    process.stderr.write(`${pathError}\n`);
    process.exitCode = 1;
    return;
  }

  // Run the command where the user's project lives, so its command and
  // resultsPath resolve relative to the project — not to our CLI's cwd.
  const cwd = dirname(absConfig);

  // Progress → stderr. A live spinner on an interactive stderr (rule #5), plain
  // lines when piped. `ora` writes to stderr so it never pollutes the stdout report.
  // `--json` suppresses the spinner entirely (rule #5 names `--json` alongside
  // piping) — progress falls back to the plain stderr lines below.
  const spinner: Ora | undefined =
    !json && isInteractive(process.stderr)
      ? ora({ stream: process.stderr, text: "⟁ Preparing specimen scan…" }).start()
      : undefined;

  // Ctrl-C mid-sweep must not leave a half-drawn spinner and a hidden cursor behind
  // (`ora` hides it while spinning). `core/runner.ts` registers the matching cleanup
  // for the spawned test process itself. Nothing to unregister: the registry is only
  // ever drained by a signal, and a normal finish exits the process.
  if (spinner) onInterrupt(() => spinner.stop());

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

  const complete = `⟁ Scan complete — ${usableRuns}/${runs.length} runs usable.`;
  if (spinner) spinner.succeed(complete);
  else process.stderr.write(`${complete}\n`);

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

  // One meta object frames every renderer. The terminal only reads the run counts;
  // the file/machine exports also carry provenance, because they get read later and
  // elsewhere by someone who never saw this session.
  const meta: ExportMeta = {
    usableRuns,
    crashedRuns,
    totalRuns: runs.length,
    generatedAt: new Date().toISOString(),
    command: config.command,
    times,
    isolation: { enabled: isolateEnabled, runs: isolationRuns },
    crashes: runs
      .filter((r) => r.crashed)
      .map((r) => ({ runIndex: r.runIndex, reason: r.crashReason, timedOut: r.timedOut })),
  };

  // stdout carries exactly one thing: the report. Under `--json` that's the JSON
  // envelope and nothing else — no banner, no colors, no log lines (rule #5).
  process.stdout.write(
    json
      ? renderJson(reports, meta)
      : renderReport(reports, meta, { color: isInteractive(process.stdout) }),
  );

  // File exports come last, so the primary result is already delivered even if an
  // export fails. Notices go to stderr to keep `--json` stdout pure.
  const exportsOk = await writeExports(reports, meta, {
    htmlPath: htmlTarget.path,
    pdfPath: pdfTarget.path,
  });
  if (!exportsOk) process.exitCode = 1;
}

/**
 * Render + write the requested file exports.
 *
 * Returns false when a *requested* export could not be produced (bad path, puppeteer
 * crash) so the caller can exit non-zero — the user asked for a file and didn't get
 * one. A missing puppeteer is deliberately NOT a failure: SPEC §8 defines that as
 * graceful degradation (hint + HTML instead), so it returns true.
 *
 * Every notice goes to stderr with plain `write` calls: by this point the sweep and
 * isolation spinners have been stopped (`.succeed`/`.fail`), so there is no live
 * spinner line left to corrupt.
 */
async function writeExports(
  reports: FlakeReport[],
  meta: ExportMeta,
  targets: { htmlPath?: string; pdfPath?: string },
): Promise<boolean> {
  const { htmlPath, pdfPath } = targets;
  if (!htmlPath && !pdfPath) return true;

  // One render feeds both flags — the PDF is literally this HTML through Chromium.
  const html = renderHtml(reports, meta);
  let ok = true;

  if (htmlPath) {
    try {
      await writeOutputFile(htmlPath, html);
      process.stderr.write(`⟁ HTML report written to ${htmlPath}\n`);
    } catch (err) {
      process.stderr.write(`✗ Could not write HTML report to ${htmlPath}: ${asMessage(err)}\n`);
      ok = false;
    }
  }

  if (pdfPath) {
    process.stderr.write("⟁ Rendering PDF via puppeteer…\n");
    const result = await writePdfReport({ html, path: pdfPath });

    if (result.ok) {
      process.stderr.write(`⟁ PDF report written to ${pdfPath}\n`);
    } else if (result.reason === "puppeteer-missing") {
      // SPEC §8: friendly hint, and still produce the HTML.
      process.stderr.write(`⚠ ${result.message}\n`);
      if (htmlPath) {
        process.stderr.write(`  ↳ The HTML report is at ${htmlPath}.\n`);
      } else {
        const fallback = htmlFallbackPath(pdfPath);
        try {
          await writeOutputFile(fallback, html);
          process.stderr.write(`  ↳ Wrote the HTML report instead: ${fallback}\n`);
        } catch (err) {
          process.stderr.write(`✗ Could not write HTML report to ${fallback}: ${asMessage(err)}\n`);
          ok = false;
        }
      }
    } else {
      process.stderr.write(`✗ PDF export failed: ${result.message}\n`);
      ok = false;
    }
  }

  return ok;
}

/**
 * Resolve an optional-value export flag into an absolute path.
 *
 * Commander gives `undefined` (flag absent), `true` (bare flag → use the default
 * filename), or a string (explicit path). Paths resolve against **`process.cwd()`**,
 * the directory the user typed the command in — deliberately NOT the config directory
 * (which is the *child test command's* cwd), because `--html ./report.html` should
 * land where the user is looking.
 */
function resolveExportPath(
  value: string | boolean | undefined,
  defaultName: string,
  flag: string,
): { path?: string; error?: string } {
  if (value === undefined || value === false) return {};
  if (value === true) return { path: resolve(process.cwd(), defaultName) };
  const trimmed = value.trim();
  if (trimmed === "") {
    return { error: `✗ ${flag} needs a file path, or pass it bare to use ./${defaultName}.` };
  }
  return { path: resolve(process.cwd(), trimmed) };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the tri-state isolation switch (Phase 9 escape hatch).
 *
 * Commander gives `true` for `--isolate`, `false` for `--no-isolate`, and
 * `undefined` when neither appears — so an explicit flag always wins and only a
 * *silent* CLI defers to the config. Exported for direct unit testing: the
 * `undefined` case is the fragile one (it depends on commander declaring
 * `--isolate` before `--no-isolate` in `cli.ts`), and a regression there would
 * quietly run — or quietly skip — a diagnosis pass.
 */
export function resolveIsolate(flag: boolean | undefined, fromConfig: boolean): boolean {
  return flag ?? fromConfig;
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
