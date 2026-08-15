import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * CLI integration tests — Group D of `docs/phases/PHASE_7_test-plan.md`, automated
 * (Phase 9).
 *
 * These drive the BUILT binary (`dist/cli.js`) as a user would, so they cover the one
 * surface nothing else touches: commander wiring, flag precedence, exit codes, and the
 * stdout/stderr split (rule #5) as they actually behave in a shell.
 *
 * ## Why a fake runner instead of the Vitest fixture
 *
 * `fixtures/sample-project` flakes for real reasons (coin flip, wall clock), which is
 * why the manual plan has to say "use `-n 15` or the flakes may not flip". Asserting
 * exact reports against a probabilistic fixture would put a FLAKY TEST INSIDE THE FLAKE
 * DETECTOR — the one thing this project must not ship. So most cases here run
 * `fixtures/fake-runner/runner.mjs`, which writes JUnit XML on a fixed schedule: at
 * N=4 there is exactly one possible report. Case C1 still sweeps the real Vitest
 * fixture, so "works against an actual test runner" stays covered, and the real-runner
 * isolation loop is covered by `isolate.live.test.ts` (L1–L5).
 *
 * A side effect worth naming: the fake runner makes `order-dependent` reachable
 * END-TO-END through the CLI. The Phase 7 docs recorded that as impossible against the
 * Vitest fixture, whose order-victim fails 100% in-suite and therefore classifies as
 * `consistently-failing` — never isolated.
 *
 * Still manual: **D5, the themed TTY eyeball.** stdout here is a pipe, so the plain
 * renderer is what runs; colors, the boxen frame and spinner need a real terminal.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "dist", "cli.js");
const FAKE_RUNNER = join(REPO, "fixtures", "fake-runner", "runner.mjs");
const REAL_FIXTURE_CONFIG = join(REPO, "fixtures", "sample-project", "flaky.config.json");

/** Forward slashes survive `cmd.exe` and dot-notation reporter flags alike. */
const posix = (p: string) => p.replace(/\\/g, "/");

/** ANSI escapes start with ESC; asserted by absence (rule #5). */
const ESC = String.fromCharCode(27);

function puppeteerInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve("puppeteer");
    return true;
  } catch {
    return false;
  }
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<CliResult> {
  const result = await execa(process.execPath, [CLI, ...args], {
    cwd: REPO,
    reject: false, // exit codes are assertions here, not failures
    all: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
  };
}

interface ConfigOverrides {
  times?: number;
  timeoutMs?: number;
  isolate?: boolean;
  isolationRuns?: number;
  /** Extra args appended to the fake runner's sweep command. */
  runnerArgs?: string;
  /** Replace the isolate template entirely; `null` removes it. */
  isolateCommand?: string | null;
}

/**
 * Write a private config + counter file for one case. Each case gets its own temp
 * directory so the fake runner's counter starts at 1 and cases cannot influence each
 * other (they share one process via `singleFork`).
 */
async function makeCase(overrides: ConfigOverrides = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flaky-cli-test-"));
  const state = posix(join(dir, "state.json"));
  const runner = posix(FAKE_RUNNER);
  const extra = overrides.runnerArgs ? ` ${overrides.runnerArgs}` : "";

  const config: Record<string, unknown> = {
    command: `node "${runner}" --out "{results}" --state "${state}"${extra}`,
    reporter: "junit",
    // Unused: the command carries a `{results}` placeholder (rule #4's primary path).
    resultsPath: "./unused-results.xml",
    times: overrides.times ?? 4,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    isolate: overrides.isolate ?? false,
    isolationRuns: overrides.isolationRuns ?? 2,
  };

  if (overrides.isolateCommand !== null) {
    config.isolateCommand =
      overrides.isolateCommand ??
      `node "${runner}" --out "{results}" --state "${state}" --only "{testName}"`;
  }

  const path = join(dir, "flaky.config.json");
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

// The suite drives `dist/`, so it must exist and match `src/`. Building here rather
// than documenting "run npm run build first" removes the way this suite could lie:
// a stale bundle would test the previous phase's code.
beforeAll(async () => {
  await execa("npx", ["tsup"], { cwd: REPO, shell: true });
}, 180_000);

// Each case spawns several short node processes; 30s is slack, not an expectation.
const CASE_TIMEOUT = 30_000;

describe("C1 — real Vitest fixture (proves it works against an actual runner)", () => {
  it("sweeps the fixture, reports, and exits 0", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "run",
      "-c",
      REAL_FIXTURE_CONFIG,
      "-n",
      "3",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Sweep complete: 3/3 runs usable.");
    // The fixture's order-victim fails deterministically in-suite, so this section
    // is the one thing about the real fixture that ISN'T probabilistic.
    expect(stdout).toContain("Consistently failing (likely real bugs, not flakes):");
    expect(stdout).toContain("victim B");
    // Rule #5: piped stdout is plain, and progress went to the other stream.
    expect(stdout.includes(ESC)).toBe(false);
    expect(stderr).toContain("Scanning specimen 1/3");
  }, 120_000); // three real Vitest runs
});

describe("C2 — baseline sweep, no isolation (D1)", () => {
  it(
    "produces the one report the deterministic runner allows",
    async () => {
      const config = await makeCase({ times: 4 });
      const { stdout, exitCode } = await runCli(["run", "-c", config]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Sweep complete: 4/4 runs usable.");
      expect(stdout).toContain("5 tests · 2 flaky · 1 consistently-failing · 2 stable.");
      // bravo + charlie fail on even runs → 2/4. `echo skipped` is skipped every run,
      // so it never enters a denominator (Phase 5 decision) and counts as stable.
      expect(stdout).toContain("fake/suite.spec.js :: bravo coin — 2/4 fails (50%)");
      expect(stdout).toContain("fake/suite.spec.js :: charlie order — 2/4 fails (50%)");
      expect(stdout).toContain("fake/suite.spec.js :: delta broken — 4/4 fails");
      // Worst-first, with the documented testId tie-break at equal flake rates.
      expect(stdout.indexOf("bravo coin")).toBeLessThan(stdout.indexOf("charlie order"));
      expect(stdout.indexOf("charlie order")).toBeLessThan(stdout.indexOf("delta broken"));
      // No isolation ran, so no diagnosis tags anywhere.
      expect(stdout).not.toContain("[");
    },
    CASE_TIMEOUT,
  );

  it(
    "prints the sampling caveat CLAUDE.md requires (Phase 9)",
    async () => {
      const config = await makeCase({ times: 4 });
      const { stdout } = await runCli(["run", "-c", config]);
      expect(stdout).toContain("this is a sample, not a proof — based on 4 runs");
    },
    CASE_TIMEOUT,
  );
});

describe("C3 — isolation diagnosis end-to-end (D2)", () => {
  it(
    "diagnoses both causes, including order-dependent through the CLI",
    async () => {
      const config = await makeCase({ times: 4, isolationRuns: 2 });
      const { stdout, exitCode } = await runCli(["run", "-c", config, "--isolate"]);

      expect(exitCode).toBe(0);
      // bravo fails even when alone → the cause is inside the test.
      expect(stdout).toContain("bravo coin — 2/4 fails (50%) [internally-nondeterministic]");
      // charlie passes every run alone → it only fails in company. This branch was
      // previously unreachable through the CLI (see the file header).
      expect(stdout).toContain("charlie order — 2/4 fails (50%) [order-dependent]");
      // Consistently-failing rows are never isolated, so they carry no tag.
      expect(stdout).toContain("delta broken — 4/4 fails\n");
      expect(stdout).not.toContain("delta broken — 4/4 fails [");
    },
    CASE_TIMEOUT,
  );

  it(
    "keeps stdout pure and progress on stderr, sequentially (D3, D4, rule #1)",
    async () => {
      const config = await makeCase({ times: 4, isolationRuns: 2 });
      const { stdout, stderr } = await runCli(["run", "-c", config, "--isolate"]);

      // stdout = the report and nothing else.
      expect(stdout).not.toContain("⟁");
      expect(stdout).not.toContain("↳");
      expect(stdout.includes(ESC)).toBe(false);

      // stderr = progress. Rule #1: every run of target 1 before target 2 begins.
      // A parallel implementation would interleave these.
      const order = [...stderr.matchAll(/run (\d+)\/(\d+) \((\d+)\/(\d+)\)/g)].map(
        (m) => `${m[3]}/${m[4]}:${m[1]}/${m[2]}`,
      );
      expect(order).toEqual(["1/2:1/2", "1/2:2/2", "2/2:1/2", "2/2:2/2"]);
      expect(stderr).toContain("Isolating 2 anomalies");
    },
    CASE_TIMEOUT,
  );
});

describe("C4 — the --no-isolate escape hatch (Phase 9)", () => {
  it(
    "honors a config that enables isolation when no flag is passed (D9)",
    async () => {
      const config = await makeCase({ times: 4, isolate: true, isolationRuns: 2 });
      const { stdout, exitCode } = await runCli(["run", "-c", config]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("[order-dependent]");
    },
    CASE_TIMEOUT,
  );

  it(
    "lets --no-isolate override a config that enables it",
    async () => {
      const config = await makeCase({ times: 4, isolate: true, isolationRuns: 2 });
      const { stdout, stderr, exitCode } = await runCli(["run", "-c", config, "--no-isolate"]);

      expect(exitCode).toBe(0);
      // The gap this closes: before Phase 9 there was no way to skip a diagnosis pass
      // a config had turned on.
      expect(stdout).not.toContain("[order-dependent]");
      expect(stdout).not.toContain("[internally-nondeterministic]");
      expect(stderr).not.toContain("Isolating");
      // …and the sweep itself is unaffected.
      expect(stdout).toContain("5 tests · 2 flaky · 1 consistently-failing · 2 stable.");
    },
    CASE_TIMEOUT,
  );

  it(
    "still defaults to the config when neither flag is passed and isolation is off",
    async () => {
      // Guards the commander declaration order in cli.ts: if `--no-isolate` were
      // declared first, `opts.isolate` would default to `true` and this would isolate.
      const config = await makeCase({ times: 4, isolate: false });
      const { stderr } = await runCli(["run", "-c", config]);
      expect(stderr).not.toContain("Isolating");
    },
    CASE_TIMEOUT,
  );
});

describe("C5 — isolation is a bonus pass, never a hard failure (D6, D7, D10, D11)", () => {
  it(
    "notes there is nothing to isolate when no test is flaky (D6)",
    async () => {
      // One run can't be both pass and fail, so nothing classifies as flaky.
      const config = await makeCase({ times: 1 });
      const { stdout, stderr, exitCode } = await runCli(["run", "-c", config, "--isolate"]);

      expect(exitCode).toBe(0);
      expect(stderr).toContain("No flaky anomalies to isolate.");
      expect(stdout).toContain("Sweep complete: 1/1 runs usable.");
    },
    CASE_TIMEOUT,
  );

  it(
    "skips with a friendly hint when no isolateCommand is configured (D7)",
    async () => {
      const config = await makeCase({ times: 4, isolateCommand: null });
      const { stdout, stderr, exitCode } = await runCli(["run", "-c", config, "--isolate"]);

      expect(exitCode).toBe(0);
      expect(stderr).toContain("--isolate needs an `isolateCommand` in your config");
      // A missing template is not an error: the report still renders in full.
      expect(stdout).toContain("5 tests · 2 flaky · 1 consistently-failing · 2 stable.");
    },
    CASE_TIMEOUT,
  );

  it(
    "ignores --isolation-runs when isolation is off (D10)",
    async () => {
      const config = await makeCase({ times: 4 });
      const { stderr, exitCode } = await runCli(["run", "-c", config, "--isolation-runs", "5"]);

      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("Isolating");
    },
    CASE_TIMEOUT,
  );

  it(
    "reports 'unknown' when every isolation run crashes (D11)",
    async () => {
      const config = await makeCase({
        times: 4,
        isolationRuns: 2,
        isolateCommand: "node no-such-isolate-script.mjs {file}",
      });
      const { stdout, exitCode } = await runCli(["run", "-c", config, "--isolate"]);

      // A broken template must never take down a successful sweep.
      expect(exitCode).toBe(0);
      expect(stdout).toContain("[unknown]");
      expect(stdout).toContain("5 tests · 2 flaky · 1 consistently-failing · 2 stable.");
    },
    CASE_TIMEOUT,
  );
});

describe("C6 — invalid flags fail before the sweep (D8)", () => {
  it.each([
    ["--isolation-runs", "abc"],
    ["--isolation-runs", "0"],
    ["--isolation-runs", "-3"],
    ["--times", "abc"],
    ["--times", "0"],
  ])(
    "rejects %s %s with exit 1 and no sweep",
    async (flag, value) => {
      const config = await makeCase();
      const { stderr, exitCode } = await runCli(["run", "-c", config, "--isolate", flag, value]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`${flag} must be a positive integer (got "${value}")`);
      // The whole point of validating up front: nothing ran.
      expect(stderr).not.toContain("Scanning specimen");
    },
    CASE_TIMEOUT,
  );

  it(
    "reports a missing config file actionably",
    async () => {
      const { stderr, exitCode } = await runCli(["run", "-c", "./no-such-flaky.config.json"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("flaky init");
    },
    CASE_TIMEOUT,
  );
});

describe("C7 — crash handling (rule #2, rule #3)", () => {
  it(
    "keeps reporting when SOME runs crash, and says how many",
    async () => {
      // Run 1 exits non-zero without writing results; runs 2-4 are fine.
      const config = await makeCase({ times: 4, runnerArgs: "--crash-on 1" });
      const { stdout, exitCode } = await runCli(["run", "-c", config]);

      expect(exitCode).toBe(0); // a report from surviving runs is still a report
      expect(stdout).toContain("Sweep complete: 3/4 runs usable, 1 crashed.");
      // The caveat must quote the USABLE denominator, not the requested N.
      expect(stdout).toContain("based on 3 runs");
    },
    CASE_TIMEOUT,
  );

  it(
    "exits 1 when NO run is usable, and explains why",
    async () => {
      const config = await makeCase({ times: 3, runnerArgs: "--no-results" });
      const { stderr, exitCode } = await runCli(["run", "-c", config]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("No usable runs — all 3 crashed.");
      expect(stderr).toContain("First failure:");
    },
    CASE_TIMEOUT,
  );

  it(
    "treats an unparseable results file as a crashed run, not as zero tests",
    async () => {
      const config = await makeCase({ times: 2, runnerArgs: "--garbage" });
      const { stderr, exitCode } = await runCli(["run", "-c", config]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Invalid JUnit XML");
    },
    CASE_TIMEOUT,
  );

  it("tree-kills a hung run at the per-run timeout instead of freezing the sweep (D12)", async () => {
    // The runner busy-spins for 20s ignoring signals; the timeout is 800ms. Rule #3
    // has to end each run, so a 2-run sweep must finish in seconds, not 40s.
    const config = await makeCase({ times: 2, timeoutMs: 800, runnerArgs: "--sleep 20000" });
    const startedAt = Date.now();
    const { stderr, exitCode } = await runCli(["run", "-c", config]);
    const elapsedMs = Date.now() - startedAt;

    expect(exitCode).toBe(1); // nothing usable was produced
    expect(stderr).toMatch(/timed out|no results file/);
    // Generous ceiling: what matters is that it isn't ~40s of hanging.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);
});

describe("C8 — export flags on the real pipeline (Phase 8 wiring)", () => {
  it(
    "--json puts one parseable envelope on stdout and zero ANSI on either stream",
    async () => {
      const config = await makeCase({ times: 4, isolationRuns: 2 });
      const { stdout, stderr, exitCode } = await runCli([
        "run",
        "-c",
        config,
        "--isolate",
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const envelope = JSON.parse(stdout); // throws if anything else reached stdout
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.counts).toMatchObject({ tests: 5, flaky: 2, consistentlyFailing: 1 });
      expect(envelope.sweep).toMatchObject({ times: 4, totalRuns: 4, usableRuns: 4 });
      expect(envelope.isolation).toMatchObject({ enabled: true, runs: 2 });
      const diagnoses = envelope.reports.map((r: { diagnosis?: string }) => r.diagnosis);
      expect(diagnoses).toContain("order-dependent");
      expect(diagnoses).toContain("internally-nondeterministic");
      // Rule #5: `--json` suppresses the spinner outright, so neither stream has ANSI.
      expect(stdout.includes(ESC)).toBe(false);
      expect(stderr.includes(ESC)).toBe(false);
      // Logs still happen — they just go to stderr.
      expect(stderr).toContain("Scanning specimen");
    },
    CASE_TIMEOUT,
  );

  it(
    "--html writes a self-contained report, creating parent directories",
    async () => {
      const config = await makeCase({ times: 4 });
      const dir = await mkdtemp(join(tmpdir(), "flaky-html-"));
      const target = join(dir, "nested", "scan.html");

      const { stderr, exitCode } = await runCli(["run", "-c", config, "--html", target]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("HTML report written to");

      const html = await readFile(target, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("bravo coin");
      // The honesty note must survive into the file that gets forwarded around.
      expect(html).toContain("statistical statement");
      // Self-contained: no external requests.
      expect(html).not.toContain("http://");
      expect(html).not.toContain("https://");
    },
    CASE_TIMEOUT,
  );

  it("--pdf either renders a PDF or degrades to HTML with a hint, never a hard failure", async () => {
    const config = await makeCase({ times: 2 });
    const dir = await mkdtemp(join(tmpdir(), "flaky-pdf-"));
    const target = join(dir, "scan.pdf");

    const { stderr, exitCode } = await runCli(["run", "-c", config, "--pdf", target]);

    // SPEC §8: a missing puppeteer is documented graceful degradation, so either
    // way the command succeeds. Both branches are asserted rather than skipped, so
    // this test is honest whichever machine runs it.
    expect(exitCode).toBe(0);
    if (puppeteerInstalled()) {
      expect(stderr).toContain("PDF report written to");
      const pdf = await readFile(target);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    } else {
      expect(stderr).toContain("npm i puppeteer");
      const fallback = await readFile(join(dir, "scan.html"), "utf8");
      expect(fallback).toContain("<!doctype html>");
    }
  }, 120_000); // Chromium startup when puppeteer IS installed

  it(
    "rejects an empty export path in milliseconds, before the sweep",
    async () => {
      const config = await makeCase({ times: 4 });
      const { stderr, exitCode } = await runCli(["run", "-c", config, "--html", ""]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("--html needs a file path");
      expect(stderr).not.toContain("Scanning specimen");
    },
    CASE_TIMEOUT,
  );
});

describe("C9 — process-level policy (Phase 9)", () => {
  it(
    "prints the banner and help with no arguments, exit 0",
    async () => {
      const { stdout, exitCode } = await runCli([]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage: flaky");
      expect(stdout).toContain("run [options]");
    },
    CASE_TIMEOUT,
  );

  it(
    "documents every run flag, including the Phase 9 escape hatch",
    async () => {
      const { stdout, exitCode } = await runCli(["run", "--help"]);
      expect(exitCode).toBe(0);
      for (const flag of [
        "--times",
        "--isolate",
        "--no-isolate",
        "--isolation-runs",
        "--json",
        "--html",
        "--pdf",
      ]) {
        expect(stdout).toContain(flag);
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "reports the shared version constant",
    async () => {
      const { stdout, exitCode } = await runCli(["--version"]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    },
    CASE_TIMEOUT,
  );
});
