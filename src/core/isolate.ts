import type { Config } from "../config/schema.js";
import type { ResultParser } from "../parsers/index.js";
import type { FlakeReport } from "../types.js";
import { toPosix } from "../utils/tempfile.js";
import { runOnce } from "./runner.js";
import { toRunResult } from "./sweep.js";

/**
 * Isolation diagnosis (SPEC §2 feature 5) — the "why is it flaky?" pass.
 *
 * For each test that came out `flaky` in the full-suite sweep, we re-run THAT ONE
 * test **alone** R times via `config.isolateCommand` and read the split:
 *   - passes all R alone       → `order-dependent`             (external cause: it
 *                                only misbehaves alongside other tests — shared
 *                                state / ordering — so on its own it's fine)
 *   - fails at least once alone → `internally-nondeterministic` (the cause lives
 *                                inside the test itself — randomness / timing)
 *   - no usable outcome         → `unknown`                    (couldn't isolate it)
 * One mechanism, two-way classification.
 *
 * The runs are still SEQUENTIAL (CLAUDE.md rule #1): even a single test re-run
 * many times can contend for ports/files, so we never parallelize. We reuse
 * `runner.runOnce` + `sweep.toRunResult` so isolation shares the exact same
 * "spawn → timeout → temp file → parse → crash detection" path as the sweep.
 */

/** The three diagnosis outcomes (the non-optional half of `FlakeReport.diagnosis`). */
export type Diagnosis = NonNullable<FlakeReport["diagnosis"]>;

/** Everything isolation needs to re-run and re-identify a single test. */
export interface TestIdentity {
  /** The correlated id (`${file} :: ${name}`), used to attach the diagnosis back. */
  testId: string;
  /** File the test lives in — substituted for `{file}` AND matched on when reading. */
  file: string;
  /** Test name — substituted for `{testName}`/`{testNamePattern}` and matched on. */
  name: string;
}

export interface IsolateProgress {
  testId: string;
  name: string;
  /** 1-based index of the current target among all targets. */
  targetIndex: number;
  totalTargets: number;
  /** 1-based index of the current alone-run for this target. */
  run: number;
  totalRuns: number;
}

export interface IsolateResult {
  testId: string;
  /** How many alone-runs the target passed / failed (skips + not-found excluded). */
  alonePasses: number;
  aloneFails: number;
  diagnosis: Diagnosis;
}

export interface IsolateOptions {
  config: Config;
  /** Resolved reporter adapter (same one the sweep used). */
  parser: ResultParser;
  /** The tests to diagnose — caller passes the `flaky` ones + their file/name. */
  targets: TestIdentity[];
  /** R — times to re-run each test alone. */
  isolationRuns: number;
  /** Directory to run in (the user's project — dir of the config file). */
  cwd?: string;
  /** Fired before each alone-run, for a stderr progress line. */
  onProgress?: (progress: IsolateProgress) => void;
}

/**
 * Diagnose every target. Returns one {@link IsolateResult} per target, in input
 * order. The caller attaches `diagnosis` back onto the matching `FlakeReport`.
 *
 * Precondition: `config.isolateCommand` is set (the caller checks and skips the
 * whole pass with a friendly message otherwise — a missing template isn't an
 * error, just "can't isolate").
 */
export async function isolate({
  config,
  parser,
  targets,
  isolationRuns,
  cwd,
  onProgress,
}: IsolateOptions): Promise<IsolateResult[]> {
  const template = config.isolateCommand;
  if (!template) {
    throw new Error("isolate() called without config.isolateCommand set");
  }

  const results: IsolateResult[] = [];
  for (const [t, target] of targets.entries()) {
    // Build the single-test command once per target; only the temp results path
    // (injected by runOnce) changes between its R runs.
    const command = buildIsolateCommand(template, target);
    const isoConfig: Config = { ...config, command };

    let alonePasses = 0;
    let aloneFails = 0;
    // SEQUENTIAL (rule #1) — awaited loop, never parallel, even for one test.
    for (let run = 1; run <= isolationRuns; run++) {
      onProgress?.({
        testId: target.testId,
        name: target.name,
        targetIndex: t + 1,
        totalTargets: targets.length,
        run,
        totalRuns: isolationRuns,
      });
      const raw = await runOnce({ config: isoConfig, runIndex: run, cwd });
      const runResult = toRunResult(raw, parser);
      if (runResult.crashed) continue; // no usable results this run — skip it

      // Match on file + name (SPEC §4): the results file often also contains the
      // OTHER tests in the file, filtered to `skip`. We want only the target's
      // definitive outcome; a skip / not-found contributes nothing.
      const hit = runResult.results.find((r) => r.file === target.file && r.name === target.name);
      if (hit?.status === "pass") alonePasses++;
      else if (hit?.status === "fail") aloneFails++;
    }

    results.push({
      testId: target.testId,
      alonePasses,
      aloneFails,
      diagnosis: diagnose(alonePasses, aloneFails),
    });
  }
  return results;
}

/**
 * Classify a test from its alone-run tally (PURE — the heart of the diagnosis,
 * unit-testable without spawning anything).
 *
 *   - no definitive outcome at all → `unknown` (filter never matched / all crashed)
 *   - passed every alone-run       → `order-dependent` (needs other tests to fail)
 *   - failed at least once alone    → `internally-nondeterministic` (fails on its own)
 */
export function diagnose(alonePasses: number, aloneFails: number): Diagnosis {
  if (alonePasses + aloneFails === 0) return "unknown";
  if (aloneFails === 0) return "order-dependent";
  return "internally-nondeterministic";
}

// ── Template substitution + the SPEC §4 "sharp edge" ─────────────────────────

const TOKENS = {
  file: "{file}",
  /** MUST be replaced before `{testName}` — it *contains* that token as a substring. */
  testNamePattern: "{testNamePattern}",
  testName: "{testName}",
} as const;

/**
 * Build the concrete single-test command from the user's `isolateCommand`
 * template. Placeholders (framework-specific filter syntax stays in the user's
 * template, keeping our tool agnostic):
 *
 *   - `{file}`            → the test's file path (forward-slashed, shell-escaped).
 *   - `{testName}`        → the raw test name, shell-escaped. For exact/substring
 *                           filters (e.g. pytest `-k`).
 *   - `{testNamePattern}` → the name regex-escaped THEN shell-escaped. For
 *                           regex-based filters (Vitest/Jest `-t`), where a name
 *                           like `foo (bar)` would otherwise mis-match because
 *                           `(...)` are regex metacharacters. This is the SPEC §4
 *                           sharp edge; see `regexEscape`.
 *
 * We only handle SHELL safety and regex-literalization here; whether a runner's
 * filter is regex or substring is the template's concern (hence two tokens).
 */
export function buildIsolateCommand(
  template: string,
  target: { file: string; name: string },
  platform: NodeJS.Platform = process.platform,
): string {
  const file = shellEscapeDoubleQuoted(toPosix(target.file), platform);
  const testName = shellEscapeDoubleQuoted(target.name, platform);
  const testNamePattern = shellEscapeDoubleQuoted(regexEscape(target.name), platform);
  return template
    .split(TOKENS.file)
    .join(file)
    .split(TOKENS.testNamePattern)
    .join(testNamePattern)
    .split(TOKENS.testName)
    .join(testName);
}

/**
 * Escape regex metacharacters so a literal test name is matched literally by a
 * regex-based test filter (Vitest/Jest `-t` compile the pattern with `new
 * RegExp`). Without this, `specimen A (coin flip)` never matches its own test
 * because `(coin flip)` is read as a capture group — verified live against the
 * fixture (the raw name matched 0 tests; the escaped one matched exactly 1).
 */
export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape a value for safe embedding inside a DOUBLE-QUOTED shell argument — the
 * conventional way templates wrap these placeholders (e.g. `-t "{testName}"`).
 * We neutralize only the characters that would break out of, or be expanded
 * within, double quotes. Platform-aware because `runner.ts` runs with
 * `shell:true` (POSIX `sh -c` vs Windows `cmd.exe /c`), whose quoting rules
 * differ. Regex-escape (if any) is applied first, so its backslashes get escaped
 * too and survive the shell to reach the runner intact.
 *
 * Known limitation (documented, SPEC §4): this covers the common cases; exotic
 * names with embedded quotes on Windows, or literal `%`, may still need the user
 * to adjust their `isolateCommand`.
 */
export function shellEscapeDoubleQuoted(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    // cmd.exe: a `"` ends the quoted region; doubling embeds a literal one.
    // Backslashes are literal in cmd, so a regex-escaped `\(` passes through.
    return value.replace(/"/g, '""');
  }
  // POSIX sh: inside "...", only \ ` $ " are special — backslash-escape them.
  return value.replace(/(["\\$`])/g, "\\$1");
}
