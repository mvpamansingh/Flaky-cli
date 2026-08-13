import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report/terminal.js";
import type { FlakeReport } from "../src/types.js";

// `renderReport` delegates color DEPTH to chalk (so it downsamples correctly on a
// real terminal). Under vitest stdout is a pipe, so chalk would otherwise strip all
// color and the ANSI assertions below couldn't run. Force truecolor here to make the
// themed path deterministic — the SUT still decides *whether* to colorize via `color`.
chalk.level = 3;

/**
 * Tests for the Phase 6 themed report renderer. It's presentation-only, so we
 * assert two guarantees:
 *   1. `color:false` (piped / non-TTY, rule #5) emits plain, ANSI-free, byte-stable
 *      text — the format pipes and future `--json` prep depend on.
 *   2. `color:true` (TTY) emits the Xenolith table + box: verdict labels, a
 *      flake-rate bar, and truecolor ANSI from the palette.
 * We never re-sort here — `renderReport` must preserve the worst-first order
 * `correlate` already produced.
 */

const ESC = String.fromCharCode(27); // ANSI escapes start with ESC (avoids a literal control char)

const reports: FlakeReport[] = [
  {
    testId: "a.test.ts :: flaky one",
    runs: 10,
    passes: 6,
    fails: 4,
    flakeRate: 0.4,
    classification: "flaky",
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

const meta = { usableRuns: 10, crashedRuns: 0, totalRuns: 10 };

describe("renderReport — plain (color:false)", () => {
  const out = renderReport(reports, meta, { color: false });

  it("emits no ANSI escape codes", () => {
    expect(out.includes(ESC)).toBe(false);
  });

  it("reports the sweep + classification counts", () => {
    expect(out).toContain("Sweep complete: 10/10 runs usable.");
    expect(out).toContain("3 tests · 1 flaky · 1 consistently-failing · 1 stable.");
  });

  it("lists flaky anomalies with fail count and percentage", () => {
    expect(out).toContain("a.test.ts :: flaky one — 4/10 fails (40%)");
  });

  it("lists consistently-failing separately from flaky", () => {
    expect(out).toContain("Consistently failing (likely real bugs, not flakes):");
    expect(out).toContain("b.test.ts :: broken one — 10/10 fails");
  });

  it("notes crashed runs when present", () => {
    const withCrash = renderReport(
      reports,
      { usableRuns: 8, crashedRuns: 2, totalRuns: 10 },
      {
        color: false,
      },
    );
    expect(withCrash).toContain("Sweep complete: 8/10 runs usable, 2 crashed.");
  });
});

describe("renderReport — themed (color:true)", () => {
  const out = renderReport(reports, meta, { color: true });

  it("emits ANSI truecolor codes", () => {
    expect(out.includes(ESC)).toBe(true);
    // #FFB627 (flaky amber) as an RGB truecolor sequence.
    expect(out).toContain("38;2;255;182;39");
  });

  it("renders a verdict label per classification", () => {
    expect(out).toContain("ANOMALY");
    expect(out).toContain("BROKEN");
    expect(out).toContain("STABLE");
  });

  it("renders a flake-rate bar with filled/empty cells and percentage", () => {
    expect(out).toContain("▓▓░░░ 40%"); // 0.4 → 2/5 filled
    expect(out).toContain("▓▓▓▓▓ 100%");
    expect(out).toContain("░░░░░ 0%");
  });

  it("wraps the summary in a titled box", () => {
    expect(out).toContain("specimen scan");
    expect(out).toContain("⟁ Sweep complete");
  });

  it("preserves worst-first order (flaky before broken before stable)", () => {
    const flakyAt = out.indexOf("flaky one");
    const brokenAt = out.indexOf("broken one");
    const stableAt = out.indexOf("stable one");
    expect(flakyAt).toBeLessThan(brokenAt);
    expect(brokenAt).toBeLessThan(stableAt);
  });
});

describe("renderReport — isolation diagnosis (Phase 7)", () => {
  // Same reports, but the two flaky ones now carry a diagnosis (as isolation
  // would attach). Broken/stable rows never get one.
  const diagnosed: FlakeReport[] = [
    { ...reports[0], diagnosis: "internally-nondeterministic" },
    {
      testId: "d.test.ts :: order flake",
      runs: 10,
      passes: 5,
      fails: 5,
      flakeRate: 0.5,
      classification: "flaky",
      diagnosis: "order-dependent",
    },
    reports[1], // consistently-failing, no diagnosis
    reports[2], // stable, no diagnosis
  ];

  it("plain: appends a [diagnosis] tag to each flaky line", () => {
    const out = renderReport(diagnosed, meta, { color: false });
    expect(out).toContain("[internally-nondeterministic]");
    expect(out).toContain("[order-dependent]");
    // Non-flaky rows are never tagged.
    expect(out).not.toContain("stable one — 0/10");
  });

  it("plain: omits the tag entirely when no report is diagnosed", () => {
    const out = renderReport(reports, meta, { color: false });
    expect(out).not.toContain("[");
  });

  it("themed: renders a Diagnosis column with short labels + a legend", () => {
    const out = renderReport(diagnosed, meta, { color: true });
    expect(out).toContain("Diagnosis");
    expect(out).toContain("⇄ ORDER");
    expect(out).toContain("⚛ INTERNAL");
    expect(out).toContain("⇄ ORDER = fails only alongside other tests");
  });

  it("themed: no Diagnosis column when isolation didn't run", () => {
    const out = renderReport(reports, meta, { color: true });
    expect(out).not.toContain("Diagnosis");
  });
});
