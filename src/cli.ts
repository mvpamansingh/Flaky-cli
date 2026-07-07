import { Command } from "commander";
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


program.action(() => {
  program.outputHelp();
});

program.parse(process.argv);
