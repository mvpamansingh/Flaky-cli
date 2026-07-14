import { access, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import chalk from "chalk";
import { DEFAULT_CONFIG_PATH } from "../config/load.js";
import { type ConfigInput, configSchema } from "../config/schema.js";

interface InitOptions {
  /** Where to write the config. Defaults to ./flaky.config.json in cwd. */
  config?: string;
}

/**
 * `flaky init` — interactive scaffold of `flaky.config.json`.
 *
 * The config is the whole language-agnostic story, so first-run friction has to
 * be near zero: sensible defaults on every prompt (just press Enter), and a
 * per-runner cheat-sheet at the end so the user knows how to make *their* runner
 * emit the results file we read.
 *
 * Colors are gated on TTY (per the non-negotiable rule); when piped, prompts and
 * output are plain, and empty answers fall back to defaults.
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const isTty = process.stdout.isTTY ?? false;
  const c = colors(isTty);

  const targetPath = resolvePath(options.config ?? DEFAULT_CONFIG_PATH);

  const reader = await createReader();
  try {
    process.stderr.write(`${c.brand("⟁ flaky init")} — scaffolding a config specimen\n\n`);

    const command = await ask(reader, c, "Test command", "npm test");
    const reporter = await askChoice(reader, c, "Reporter", ["junit", "json"], "junit");
    const resultsPath = await ask(
      reader,
      c,
      "Results path (where your runner writes results)",
      "./reports/junit.xml",
    );
    const times = await askInt(reader, c, "Default runs per sweep (N)", 20);
    const isolateCommand = await ask(
      reader,
      c,
      `Isolate command ${c.dim("(optional — run ONE test alone; {file} {testName})")}`,
      "",
    );

    const draft: ConfigInput = {
      command,
      reporter,
      resultsPath,
      times,
      ...(isolateCommand ? { isolateCommand } : {}),
    };

    // Round-trip through the schema so init and the loader can never drift, and
    // so defaults are materialized into the written file.
    const config = configSchema.parse(draft);

    if (await exists(targetPath)) {
      const ok = await askYesNo(reader, c, `${targetPath} already exists — overwrite?`, false);
      if (!ok) {
        process.stderr.write(c.dim("\nAborted — existing config left untouched.\n"));
        return;
      }
    }

    await writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    process.stderr.write(`\n${c.secondary("✔ Wrote")} ${targetPath}\n`);
    printReporterHints(c, config.reporter);
    process.stderr.write(
      `\n${c.dim("Next:")} run ${c.brand("flaky run")} to scan for anomalies.\n`,
    );
  } finally {
    reader.close();
  }
}

// ── input source ───────────────────────────────────────────────────────────────

/** Abstracts "print a prompt, get a line" so prompts work identically whether
 * input is an interactive TTY or a piped/scripted stream. */
interface LineReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Build the right reader for the current stdin:
 *  - **TTY** → live `readline/promises`, one question at a time.
 *  - **piped / non-interactive** → pre-read every line up front, then answer
 *    prompts in order (empty once exhausted → defaults). Pre-reading avoids the
 *    readline race where buffered lines are dropped and a later `question()`
 *    hangs forever on a stream that already closed.
 */
async function createReader(): Promise<LineReader> {
  const isTty = process.stdin.isTTY ?? false;

  if (isTty) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
      question: (prompt) => rl.question(prompt),
      close: () => rl.close(),
    };
  }

  const lines = await readAllLines(process.stdin);
  let i = 0;
  return {
    question: async (prompt) => {
      const line = i < lines.length ? (lines[i++] ?? "") : "";
      // Echo the prompt + chosen answer so scripted runs stay legible in logs.
      process.stdout.write(`${prompt}${line}\n`);
      return line;
    },
    close: () => {},
  };
}

/** Drain a readable stream to string and split into lines (drops the trailing
 * empty line from a final newline). Returns [] if there's nothing to read. */
async function readAllLines(stream: Readable): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

// ── prompts ──────────────────────────────────────────────────────────────────

async function ask(
  reader: LineReader,
  c: Colors,
  label: string,
  fallback: string,
): Promise<string> {
  const suffix = fallback ? c.dim(` [${fallback}]`) : c.dim(" [none]");
  const answer = (await reader.question(`${c.prompt("?")} ${label}${suffix} `)).trim();
  return answer || fallback;
}

async function askChoice<T extends string>(
  reader: LineReader,
  c: Colors,
  label: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  while (true) {
    const answer = (
      await reader.question(
        `${c.prompt("?")} ${label} ${c.dim(`(${choices.join("/")})`)} ${c.dim(`[${fallback}]`)} `,
      )
    ).trim();
    if (!answer) return fallback;
    const match = choices.find((choice) => choice === answer);
    if (match) return match;
    process.stderr.write(c.flaky(`  ↳ pick one of: ${choices.join(", ")}\n`));
  }
}

async function askInt(
  reader: LineReader,
  c: Colors,
  label: string,
  fallback: number,
): Promise<number> {
  while (true) {
    const answer = (
      await reader.question(`${c.prompt("?")} ${label}${c.dim(` [${fallback}]`)} `)
    ).trim();
    if (!answer) return fallback;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1) return n;
    process.stderr.write(c.flaky("  ↳ enter a whole number ≥ 1\n"));
  }
}

async function askYesNo(
  reader: LineReader,
  c: Colors,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await reader.question(`${c.prompt("?")} ${label} ${c.dim(`(${hint})`)} `))
    .trim()
    .toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

// ── reporter cheat-sheet ───────────────────────────────────────────────────────

/**
 * Print the exact flag/config each common runner needs to emit results to the
 * chosen path. This is the bridge from "I have tests" to "flaky can read them".
 */
function printReporterHints(c: Colors, reporter: "junit" | "json"): void {
  if (reporter !== "junit") {
    process.stderr.write(
      `\n${c.dim("Note:")} the ${c.brand("json")} reporter parser lands in a later phase; ` +
        `${c.brand("junit")} is the supported format today.\n`,
    );
    return;
  }

  const hints: Array<[string, string]> = [
    ["Vitest", 'vitest.config: reporters: ["junit"], outputFile: "./reports/junit.xml"'],
    ["Jest", 'reporters: ["default", "jest-junit"]  (npm i -D jest-junit)'],
    ["pytest", "pytest --junitxml=./reports/junit.xml"],
    ["go test", "gotestsum --junitfile ./reports/junit.xml"],
    ["Mocha", "mocha --reporter mocha-junit-reporter  (npm i -D mocha-junit-reporter)"],
  ];

  process.stderr.write(`\n${c.brand("Make your runner emit JUnit XML to the results path:")}\n`);
  const width = Math.max(...hints.map(([name]) => name.length));
  for (const [name, hint] of hints) {
    process.stderr.write(`  ${c.secondary(name.padEnd(width))}  ${c.dim(hint)}\n`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface Colors {
  brand: (s: string) => string;
  secondary: (s: string) => string;
  flaky: (s: string) => string;
  dim: (s: string) => string;
  prompt: (s: string) => string;
}

/** Xenolith-tinted formatters, or identity functions when not a TTY. */
function colors(isTty: boolean): Colors {
  if (!isTty) {
    const id = (s: string) => s;
    return { brand: id, secondary: id, flaky: id, dim: id, prompt: id };
  }
  return {
    brand: (s) => chalk.hex("#00F5D4")(s),
    secondary: (s) => chalk.hex("#5EF38C")(s),
    flaky: (s) => chalk.hex("#FFB627")(s),
    dim: (s) => chalk.hex("#8892B0")(s),
    prompt: (s) => chalk.hex("#00F5D4").bold(s),
  };
}
