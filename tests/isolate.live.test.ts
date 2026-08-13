import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import type { Config } from "../src/config/schema.js";
import { type IsolateProgress, isolate } from "../src/core/isolate.js";
import { getParser } from "../src/parsers/index.js";

/**
 * LIVE integration tests for the isolation I/O loop (`isolate()`), run against
 * `fixtures/sample-project` with a REAL Vitest subprocess per alone-run. This is
 * the only way to cover what mocking can't: the regex + shell escaping actually
 * surviving execa → the platform shell, and crash detection on real runs.
 *
 *   npm run test:live
 *
 * They are excluded from `npm test` by `vitest.config.ts` and run one file at a
 * time via `vitest.live.config.ts` (rule #1 — see that file's note). The PURE
 * parts (diagnose / escaping / template) live in `tests/isolate.test.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../fixtures/sample-project");
const FIXTURE_CONFIG = resolve(FIXTURE, "flaky.config.json");

/**
 * Per-run timeout for live tests, overriding the fixture's product default
 * (300000 — a sensible ceiling for real users' suites, far too slack for ours).
 * A fixture run takes ~2s, so 30s is generous while keeping rule #3's tree-kill
 * the FIRST guard to fire.
 */
const RUN_TIMEOUT_MS = 30_000;

/**
 * Vitest's own ceiling for one `it()` block. It must EXCEED R × the per-run
 * timeout, or the harness and rule #3's tree-kill race: Vitest would abort with
 * an opaque "test timed out" instead of letting `runOnce` report a clean crash
 * (which surfaces as `unknown` and a meaningful assertion failure).
 */
const budget = (runs: number) => runs * RUN_TIMEOUT_MS + 30_000;

/** The fixture's specimens, as `correlate` ids them (`${file} :: ${name}`). */
const VICTIM_B = {
  testId: "tests/order.test.ts :: victim B — assumes a clean resource (fails after the polluter)",
  file: "tests/order.test.ts",
  name: "victim B — assumes a clean resource (fails after the polluter)",
};
const SPECIMEN_A = {
  testId: "tests/random.test.ts :: specimen A — coin flip (fails ~30% at random)",
  file: "tests/random.test.ts",
  name: "specimen A — coin flip (fails ~30% at random)",
};

/** The real fixture config, with the live per-run timeout applied. */
async function liveConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const config = await loadConfig(FIXTURE_CONFIG);
  return { ...config, timeoutMs: RUN_TIMEOUT_MS, ...overrides };
}

describe("isolate() — live against fixtures/sample-project", () => {
  it(
    "L1: order-dependent — victim B passes every alone-run (external cause)",
    async () => {
      const config = await liveConfig();
      const [result] = await isolate({
        config,
        parser: getParser(config.reporter),
        targets: [VICTIM_B],
        isolationRuns: 3,
        cwd: FIXTURE,
      });

      // The whole point of the fixture: B only fails when the polluter ran first.
      expect(result.alonePasses).toBe(3);
      expect(result.aloneFails).toBe(0);
      expect(result.diagnosis).toBe("order-dependent");
    },
    budget(3),
  );

  it(
    "L2: every alone-run yields a definitive outcome (file+name matching works)",
    async () => {
      const config = await liveConfig();
      const R = 6;
      const [result] = await isolate({
        config,
        parser: getParser(config.reporter),
        targets: [SPECIMEN_A],
        isolationRuns: R,
        cwd: FIXTURE,
      });

      // A is a coin flip, so we can't assert WHICH way it lands — but every run
      // must produce a pass or a fail for the target. A shortfall means the `-t`
      // filter missed, or the file/name match failed, or runs crashed.
      expect(result.alonePasses + result.aloneFails).toBe(R);
      // Diagnosis must agree with the tally it was derived from.
      expect(result.diagnosis).toBe(
        result.aloneFails === 0 ? "order-dependent" : "internally-nondeterministic",
      );
    },
    budget(6),
  );

  it(
    "L3: a target the filter can never match → unknown, not a crash",
    async () => {
      const config = await liveConfig();
      const [result] = await isolate({
        config,
        parser: getParser(config.reporter),
        targets: [{ ...SPECIMEN_A, name: "no such specimen exists anywhere" }],
        isolationRuns: 2,
        cwd: FIXTURE,
      });

      expect(result.alonePasses).toBe(0);
      expect(result.aloneFails).toBe(0);
      expect(result.diagnosis).toBe("unknown");
    },
    budget(2),
  );

  it(
    "L4: a broken isolateCommand crashes every run → unknown, still resolves",
    async () => {
      const config = await liveConfig({
        isolateCommand: "flaky-no-such-binary {file} {testNamePattern}",
      });
      const [result] = await isolate({
        config,
        parser: getParser(config.reporter),
        targets: [SPECIMEN_A],
        isolationRuns: 2,
        cwd: FIXTURE,
      });

      // Crashed runs are skipped, never counted — isolation degrades to "unknown"
      // instead of throwing (it's a bonus pass, never a hard failure).
      expect(result.alonePasses + result.aloneFails).toBe(0);
      expect(result.diagnosis).toBe("unknown");
    },
    budget(2),
  );

  it(
    "L5: runs are SEQUENTIAL and in target order (rule #1)",
    async () => {
      const config = await liveConfig();
      const seen: string[] = [];
      const results = await isolate({
        config,
        parser: getParser(config.reporter),
        targets: [VICTIM_B, SPECIMEN_A],
        isolationRuns: 2,
        cwd: FIXTURE,
        onProgress: (p: IsolateProgress) =>
          seen.push(`${p.targetIndex}/${p.totalTargets}:${p.run}/${p.totalRuns}`),
      });

      // Parallel execution would interleave these; sequential gives exact order.
      expect(seen).toEqual(["1/2:1/2", "1/2:2/2", "2/2:1/2", "2/2:2/2"]);
      // Results come back one per target, in input order.
      expect(results.map((r) => r.testId)).toEqual([VICTIM_B.testId, SPECIMEN_A.testId]);
    },
    budget(4),
  );
});
