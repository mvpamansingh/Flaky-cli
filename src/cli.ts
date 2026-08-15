import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { renderBanner } from "./theme/banner.js";
import { installInterruptHandler } from "./utils/interrupt.js";
import { nodeVersionError } from "./utils/runtime.js";
import { TOOL_VERSION } from "./version.js";

/**
 * Entry point. Thin by design (SPEC §11): it wires commander to command modules and
 * owns only *process-level* policy — runtime guard, signal handling, the last-resort
 * error boundary, and exit codes.
 */

// Fail with a sentence rather than a stack trace from inside a dependency: `engines`
// only makes npm *warn*, and `npx` runs regardless.
const versionProblem = nodeVersionError(process.version);
if (versionProblem) {
  process.stderr.write(`${versionProblem}\n`);
  process.exit(1);
}

// The large-sweep warning invites Ctrl-C, so make Ctrl-C clean: stop the spinner,
// restore the cursor, and take the spawned test-process tree down with us instead of
// orphaning someone's entire suite. Registered before any command runs.
installInterruptHandler((message) => process.stderr.write(message));

const program = new Command();

program
  .name("flaky")
  .description(
    "Framework-agnostic CLI that detects flaky tests by running an existing test suite N times and correlating results.",
  )
  // Shared with the exports' provenance block so `--version` and a report's footer
  // can never disagree (see src/version.ts).
  .version(TOOL_VERSION, "-v, --version", "print the version")
  // This will show the Xenolith banner above the help text.
  .addHelpText("beforeAll", renderBanner());

program
  .command("init")
  .description("Interactively scaffold a flaky.config.json")
  .option("-c, --config <path>", "where to write the config", "./flaky.config.json")
  .action(async (opts: { config?: string }) => {
    await runInit({ config: opts.config });
  });

program
  .command("run")
  .description("Run the test suite repeatedly and detect flaky tests")
  .option("-c, --config <path>", "config location", "./flaky.config.json")
  .option("-n, --times <count>", "number of full-suite runs (overrides config)")
  .option("--isolate", "diagnose each flaky test by re-running it alone")
  // ORDER IS LOAD-BEARING: `--isolate` must be declared BEFORE `--no-isolate`.
  // Commander only leaves `opts.isolate` `undefined` (→ `?? config.isolate` in
  // commands/run.ts honors the config) when the positive form is declared first;
  // declaring the negation first defaults it to `true`, which would silently
  // force isolation on every sweep. Verified empirically against commander 13.
  .option("--no-isolate", "skip isolation diagnosis even if the config enables it")
  .option(
    "--isolation-runs <count>",
    "times to re-run each flaky test alone during isolation (overrides config)",
  )
  // Exports (Phase 8). `--html`/`--pdf` take an OPTIONAL path — bare flags use a
  // default filename in the current directory.
  .option("--json", "emit machine-readable JSON on stdout (all logs go to stderr)")
  .option("--html [path]", "write a styled HTML report (default: ./flaky-report.html)")
  .option("--pdf [path]", "write a PDF report via puppeteer (default: ./flaky-report.pdf)")
  .action(
    async (opts: {
      config?: string;
      times?: string;
      isolate?: boolean;
      isolationRuns?: string;
      json?: boolean;
      html?: string | boolean;
      pdf?: string | boolean;
    }) => {
      await runCommand({
        config: opts.config,
        times: opts.times,
        isolate: opts.isolate,
        isolationRuns: opts.isolationRuns,
        json: opts.json,
        html: opts.html,
        pdf: opts.pdf,
      });
    },
  );

program.action(() => {
  program.outputHelp();
});

/**
 * Last-resort error boundary.
 *
 * The command actions are `async`, so `program.parse` (which does not await them) would
 * turn any unexpected throw into an unhandled-rejection dump: a wall of stack trace with
 * our internals in it, and — depending on the Node version — possibly even exit code 0.
 * `parseAsync` lets us catch it, print one honest line, and exit 1 (the Decisions-log
 * rule: non-zero means we couldn't produce a report).
 *
 * The stack is not discarded, just gated behind `FLAKY_DEBUG=1`, because for a bug
 * report it's the only thing that matters.
 */
program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`✗ Unexpected error: ${message}\n`);
  if (process.env.FLAKY_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  } else {
    process.stderr.write("  ↳ Re-run with FLAKY_DEBUG=1 for the full stack trace.\n");
  }
  process.exitCode = 1;
});
