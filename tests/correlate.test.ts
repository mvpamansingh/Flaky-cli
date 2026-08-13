import { describe, expect, it } from "vitest";
import { correlate } from "../src/core/correlate.js";
import type { RunResult, Status, TestResult } from "../src/types.js";

/**
 * Unit tests for the PURE heart of the tool. No I/O — we hand-build `RunResult[]`
 * and assert the classification / flake-rate math directly.
 */

let runCounter = 0;

/** Build a RunResult from a map of testId → status for that run. */
function run(statuses: Record<string, Status>, opts: { crashed?: boolean } = {}): RunResult {
  runCounter += 1;
  const results: TestResult[] = Object.entries(statuses).map(([id, status]) => ({
    id,
    file: id,
    name: id,
    status,
  }));
  return {
    runIndex: runCounter,
    startedAt: "2026-07-21T00:00:00.000Z",
    results: opts.crashed ? [] : results,
    runnerExitCode: 0,
    crashed: opts.crashed ?? false,
    timedOut: false,
  };
}

describe("correlate", () => {
  it("classifies a mix of pass and fail as flaky with the right flake rate", () => {
    const runs = [
      run({ t: "pass" }),
      run({ t: "fail" }),
      run({ t: "pass" }),
      run({ t: "fail" }),
      run({ t: "pass" }),
    ];
    const [report] = correlate(runs);
    expect(report.classification).toBe("flaky");
    expect(report.runs).toBe(5);
    expect(report.passes).toBe(3);
    expect(report.fails).toBe(2);
    expect(report.flakeRate).toBeCloseTo(2 / 5);
  });

  it("classifies all-pass as stable-pass with flakeRate 0", () => {
    const reports = correlate([run({ t: "pass" }), run({ t: "pass" }), run({ t: "pass" })]);
    expect(reports).toHaveLength(1);
    expect(reports[0].classification).toBe("stable-pass");
    expect(reports[0].flakeRate).toBe(0);
  });

  it("classifies all-fail as consistently-failing, not flaky", () => {
    const reports = correlate([run({ t: "fail" }), run({ t: "fail" })]);
    expect(reports[0].classification).toBe("consistently-failing");
    expect(reports[0].flakeRate).toBe(1);
  });

  it("ignores crashed runs entirely (they never corrupt aggregation)", () => {
    const runs = [
      run({ t: "pass" }),
      run({}, { crashed: true }), // crashed — must not count
      run({ t: "pass" }),
    ];
    const [report] = correlate(runs);
    expect(report.runs).toBe(2);
    expect(report.passes).toBe(2);
    expect(report.classification).toBe("stable-pass");
  });

  it("excludes skips from the flake denominator", () => {
    // 2 pass, 1 fail, 2 skip → denominator is the 3 definitive outcomes.
    const runs = [
      run({ t: "pass" }),
      run({ t: "skip" }),
      run({ t: "fail" }),
      run({ t: "skip" }),
      run({ t: "pass" }),
    ];
    const [report] = correlate(runs);
    expect(report.runs).toBe(3);
    expect(report.passes).toBe(2);
    expect(report.fails).toBe(1);
    expect(report.flakeRate).toBeCloseTo(1 / 3);
    expect(report.classification).toBe("flaky");
  });

  it("orders worst-first: flaky (by rate desc) → consistently-failing → stable", () => {
    const runs = [
      run({ lowFlake: "pass", highFlake: "fail", failing: "fail", stable: "pass" }),
      run({ lowFlake: "pass", highFlake: "fail", failing: "fail", stable: "pass" }),
      run({ lowFlake: "pass", highFlake: "pass", failing: "fail", stable: "pass" }),
      run({ lowFlake: "fail", highFlake: "pass", failing: "fail", stable: "pass" }),
    ];
    const order = correlate(runs).map((r) => r.testId);
    expect(order).toEqual(["highFlake", "lowFlake", "failing", "stable"]);
  });

  it("returns an empty report list when there are no usable runs", () => {
    expect(correlate([run({}, { crashed: true })])).toEqual([]);
  });
});
