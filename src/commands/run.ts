import { dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { runOnce } from "../core/runner.js";
import { getParser } from "../parsers/index.js";
import type { RawRun, RunResult } from "../types.js";

/**
 * `flaky run` — the pipeline conductor.
 *
 * PHASE 4 SCOPE: still a SINGLE run, but the captured results file is now
 * PARSED into a normalized `RunResult` via the reporter's adapter, and the run
 * reports a real test count + pass/fail/skip breakdown. Phase 5 wraps `runOnce`
 * in the sequential N-times loop and correlates; Phase 6 adds the themed report.
 * Logs go to stderr so stdout stays clean for the future `--json` mode (rule #5).
 */

export interface RunOptions {
  config?: string;
}

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

  // Run the command where the user's project lives, so its command and
  // resultsPath resolve relative to the project — not to our CLI's cwd.
  const cwd = dirname(absConfig);

  process.stderr.write(`⟁ Scanning specimen 1/1 — ${config.command}\n`);
  const raw = await runOnce({ config, runIndex: 1, cwd });

  const run = toRunResult(raw, parser);
  if (run.crashed) {
    // The tool couldn't produce a usable report — an operational failure (like a
    // config error), not a flaky-test *finding*, so it exits non-zero. This is a
    // SINGLE run; Phase 5 exits non-zero only when NO run in the sweep yields
    // usable results — a report built from surviving runs still exits 0.
    process.stderr.write(`✗ Runner crashed: ${raw.crashReason}\n`);
    process.exitCode = 1;
    return;
  }

  const timeoutNote = run.timedOut ? " (timed out)" : "";
  const { total, pass, fail, skip } = countByStatus(run);
  process.stderr.write(
    `✓ Run complete — runner exit ${run.runnerExitCode}${timeoutNote}; ` +
      `parsed ${total} tests (${pass} pass, ${fail} fail, ${skip} skip)\n`,
  );
}

/**
 * Turn a raw (unparsed) run into a fully-parsed {@link RunResult}.
 *
 * A run that the runner already flagged as crashed stays crashed. Otherwise we
 * parse `resultsXml`; if parsing throws, the file is unparseable — which SPEC §6
 * treats as a crashed run (the runner produced something, but not usable
 * results), NOT as a run where tests merely failed.
 */
function toRunResult(raw: RawRun, parser: ReturnType<typeof getParser>): RunResult {
  const base = {
    runIndex: raw.runIndex,
    startedAt: raw.startedAt,
    runnerExitCode: raw.runnerExitCode,
    timedOut: raw.timedOut,
  };
  if (raw.crashed) {
    return { ...base, results: [], crashed: true };
  }
  try {
    const results = parser.parse(raw.resultsXml ?? "");
    return { ...base, results, crashed: false };
  } catch (err) {
    raw.crashReason = `Could not parse results at ${raw.resultsPath}: ${(err as Error).message}`;
    return { ...base, results: [], crashed: true };
  }
}

function countByStatus(run: RunResult): {
  total: number;
  pass: number;
  fail: number;
  skip: number;
} {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const r of run.results) {
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else skip++;
  }
  return { total: run.results.length, pass, fail, skip };
}
