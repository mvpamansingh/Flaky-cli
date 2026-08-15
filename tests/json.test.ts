import { describe, expect, it } from "vitest";
import { JSON_SCHEMA_VERSION, buildJsonReport, renderJson } from "../src/report/json.js";
import type { ExportMeta } from "../src/report/types.js";
import type { FlakeReport } from "../src/types.js";

/**
 * Tests for the Phase 8 `--json` envelope. This is a *contract* other programs will
 * depend on (CI gating, a future GitHub Action), so the assertions are deliberately
 * about the shape and not just "it produced some JSON":
 *   1. the envelope is versioned and carries provenance (what ran, when, how often);
 *   2. `reports` passes through untouched, in `correlate`'s worst-first order;
 *   3. the string form is parseable, ANSI-free, and nothing but JSON (rule #5).
 */

const reports: FlakeReport[] = [
  {
    testId: "a.test.ts :: flaky one",
    runs: 10,
    passes: 6,
    fails: 4,
    flakeRate: 0.4,
    classification: "flaky",
    diagnosis: "internally-nondeterministic",
  },
  {
    testId: "b.test.ts :: broken one",
    runs: 10,
    passes: 0,
    fails: 10,
    flakeRate: 1,
    classification: "consistently-failing",
  },
  {
    testId: "c.test.ts :: stable one",
    runs: 10,
    passes: 10,
    fails: 0,
    flakeRate: 0,
    classification: "stable-pass",
  },
];

const meta: ExportMeta = {
  usableRuns: 10,
  crashedRuns: 0,
  totalRuns: 10,
  generatedAt: "2026-08-13T12:00:00.000Z",
  command: "npm test",
  times: 10,
  isolation: { enabled: true, runs: 5 },
  crashes: [],
};

describe("buildJsonReport", () => {
  const envelope = buildJsonReport(reports, meta);

  it("stamps the schema version and the tool identity", () => {
    expect(envelope.schemaVersion).toBe(JSON_SCHEMA_VERSION);
    expect(envelope.tool.name).toBe("flaky-test-detective");
    expect(typeof envelope.tool.version).toBe("string");
  });

  it("carries sweep provenance so the numbers can be interpreted later", () => {
    expect(envelope.generatedAt).toBe("2026-08-13T12:00:00.000Z");
    expect(envelope.sweep).toMatchObject({
      command: "npm test",
      times: 10,
      totalRuns: 10,
      usableRuns: 10,
      crashedRuns: 0,
    });
    expect(envelope.isolation).toEqual({ enabled: true, runs: 5 });
  });

  it("counts each classification", () => {
    expect(envelope.counts).toEqual({
      tests: 3,
      flaky: 1,
      consistentlyFailing: 1,
      stablePass: 1,
    });
  });

  it("passes reports through untouched, preserving worst-first order", () => {
    expect(envelope.reports).toEqual(reports);
    expect(envelope.reports.map((r) => r.classification)).toEqual([
      "flaky",
      "consistently-failing",
      "stable-pass",
    ]);
  });

  it("includes the diagnosis when isolation attached one", () => {
    expect(envelope.reports[0]?.diagnosis).toBe("internally-nondeterministic");
  });

  it("surfaces crashed runs so a shrunken denominator is explainable", () => {
    const withCrash = buildJsonReport(reports, {
      ...meta,
      usableRuns: 8,
      crashedRuns: 2,
      crashes: [
        { runIndex: 3, reason: "no results file", timedOut: false },
        { runIndex: 7, reason: "timed out after 300000ms", timedOut: true },
      ],
    });
    expect(withCrash.sweep.crashedRuns).toBe(2);
    expect(withCrash.sweep.crashes).toHaveLength(2);
    expect(withCrash.sweep.crashes[1]).toEqual({
      runIndex: 7,
      reason: "timed out after 300000ms",
      timedOut: true,
    });
  });

  it("handles an empty report set (all runs crashed / nothing collected)", () => {
    const empty = buildJsonReport([], meta);
    expect(empty.counts).toEqual({ tests: 0, flaky: 0, consistentlyFailing: 0, stablePass: 0 });
    expect(empty.reports).toEqual([]);
  });
});

describe("renderJson", () => {
  const out = renderJson(reports, meta);

  it("emits parseable JSON and nothing else", () => {
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual(buildJsonReport(reports, meta));
  });

  it("emits no ANSI escape codes (rule #5)", () => {
    expect(out.includes(String.fromCharCode(27))).toBe(false);
  });

  it("starts with `{` and ends with exactly one trailing newline", () => {
    expect(out.startsWith("{")).toBe(true);
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("is pretty-printed for humans reading CI logs", () => {
    expect(out).toContain('\n  "schemaVersion"');
  });
});
