import { dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { runOnce } from "../core/runner.js";

/**
 * `flaky run` — the pipeline conductor.
 *
 * PHASE 3 SCOPE: this currently performs a SINGLE run and reports whether the
 * runner produced usable results. It exists now as the real caller that lets us
 * verify the run engine end-to-end. Phase 5 wraps `runOnce` in the sequential
 * N-times loop; Phase 4 adds parsing; Phase 6 adds the themed report. Logs go to
 * stderr so stdout stays clean for the future `--json` mode (rule #5).
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

  // Run the command where the user's project lives, so its command and
  // resultsPath resolve relative to the project — not to our CLI's cwd.
  const cwd = dirname(absConfig);

  process.stderr.write(`⟁ Scanning specimen 1/1 — ${config.command}\n`);
  const run = await runOnce({ config, runIndex: 1, cwd });

  if (run.crashed) {
    // The tool couldn't produce a report at all — that's an operational failure,
    // not a flaky-test *finding*, so it exits non-zero (like a config error). NB
    // this is a SINGLE run; Phase 5 exits non-zero only when NO run in the sweep
    // yields usable results — a report built from the surviving runs still exits 0.
    process.stderr.write(`✗ Runner crashed: ${run.crashReason}\n`);
    process.exitCode = 1;
    return;
  }

  const bytes = run.resultsXml?.length ?? 0;
  const timeoutNote = run.timedOut ? " (timed out)" : "";
  process.stderr.write(
    `✓ Run complete — runner exit ${run.runnerExitCode}${timeoutNote}; ` +
      `captured ${bytes} bytes of results from ${run.resultsPath}\n`,
  );
}
