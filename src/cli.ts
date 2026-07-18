import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { renderBanner } from "./theme/banner.js";

const program = new Command();

program
  .name("flaky")
  .description(
    "Framework-agnostic CLI that detects flaky tests by running an existing test suite N times and correlating results.",
  )
  .version("0.0.0", "-v, --version", "print the version")
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
  .action(async (opts: { config?: string }) => {
    await runCommand({ config: opts.config });
  });

program.action(() => {
  program.outputHelp();
});

program.parse(process.argv);
