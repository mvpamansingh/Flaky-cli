import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { renderBanner } from "./theme/banner.js";
import { TOOL_VERSION } from "./version.js";

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

program.parse(process.argv);
