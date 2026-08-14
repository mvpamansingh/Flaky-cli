import { describe, expect, it } from "vitest";
import { renderHtml } from "../src/report/html.js";
import type { ExportMeta } from "../src/report/types.js";
import { palette } from "../src/theme/palette.js";
import type { FlakeReport } from "../src/types.js";

/**
 * Tests for the Phase 8 `--html` export. `renderHtml` is pure string-in/string-out,
 * so we can assert the guarantees that actually matter without a browser:
 *   1. every specimen, verdict and rate reaches the document;
 *   2. it is **self-contained** (no external requests) — the file must work offline
 *      and print identically through puppeteer;
 *   3. it is themed from `theme/palette.ts`, not from hardcoded hexes;
 *   4. arbitrary test names are **escaped** (test names are user data);
 *   5. the diagnosis column appears only when isolation ran (mirrors the terminal).
 */

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

const meta: ExportMeta = {
  usableRuns: 10,
  crashedRuns: 0,
  totalRuns: 10,
  generatedAt: "2026-08-13T12:00:00.000Z",
  command: "npm test",
  times: 10,
  isolation: { enabled: false, runs: 10 },
  crashes: [],
};

describe("renderHtml — document shape", () => {
  const out = renderHtml(reports, meta);

  it("is a complete HTML document", () => {
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>Flaky Detective — specimen scan</title>");
    expect(out.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("is self-contained — no external stylesheets, scripts, fonts or images", () => {
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<img");
  });

  it("inlines the Xenolith palette from theme/palette.ts", () => {
    expect(out).toContain(palette.brand);
    expect(out).toContain(palette.flaky);
    expect(out).toContain(palette.broken);
    expect(out).toContain(palette.secondary);
    expect(out).toContain(palette.surface);
  });

  it("carries the sweep provenance a detached report needs", () => {
    expect(out).toContain("npm test");
    expect(out).toContain("2026-08-13T12:00:00.000Z");
    expect(out).toContain("10 usable of 10");
  });

  it("states the sampling caveat honestly (CLAUDE.md)", () => {
    expect(out).toContain("This is a statistical statement, not a guarantee.");
  });

  it("keeps print/PDF rules so a dark report survives Chromium", () => {
    expect(out).toContain("print-color-adjust: exact");
    expect(out).toContain("break-inside: avoid");
  });
});

describe("renderHtml — specimens", () => {
  const out = renderHtml(reports, meta);

  it("lists every specimen id", () => {
    for (const r of reports) expect(out).toContain(r.testId);
  });

  it("labels each verdict with an icon AND text (never color alone)", () => {
    expect(out).toContain("◈ ANOMALY");
    expect(out).toContain("✖ BROKEN");
    expect(out).toContain("✓ STABLE");
  });

  it("renders an instability meter whose width and printed value agree", () => {
    expect(out).toContain('style="width:40%"');
    expect(out).toContain(">40%<");
    expect(out).toContain('style="width:100%"');
    expect(out).toContain('style="width:0%"');
  });

  it("labels the meter for screen readers", () => {
    expect(out).toContain('aria-label="instability 40 percent"');
  });

  it("shows the pass/fail split per specimen", () => {
    expect(out).toContain("6✓");
    expect(out).toContain("4✗");
  });

  it("preserves worst-first order (never re-sorts)", () => {
    const flakyAt = out.indexOf("flaky one");
    const brokenAt = out.indexOf("broken one");
    const stableAt = out.indexOf("stable one");
    expect(flakyAt).toBeLessThan(brokenAt);
    expect(brokenAt).toBeLessThan(stableAt);
  });

  it("counts classifications in the summary tiles", () => {
    expect(out).toContain('class="tile tile--flaky"');
    expect(out).toContain("Anomalies");
    expect(out).toContain("Specimens");
  });

  it("says so plainly when there are no specimens", () => {
    const empty = renderHtml([], meta);
    expect(empty).toContain("No specimens recorded");
    expect(empty).not.toContain("<table>");
  });
});

describe("renderHtml — escaping (test names are user data)", () => {
  it("escapes markup in test ids and the command", () => {
    const hostile: FlakeReport[] = [
      {
        testId: 'x.test.ts :: renders <div> & "quotes" <script>alert(1)</script>',
        runs: 4,
        passes: 2,
        fails: 2,
        flakeRate: 0.5,
        classification: "flaky",
      },
    ];
    const out = renderHtml(hostile, { ...meta, command: 'npm test -- --grep "<a>"' });

    // The dangerous forms must not survive…
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain("renders <div>");
    expect(out).not.toContain('--grep "<a>"');
    // …but the text must still be readable to a human.
    expect(out).toContain("renders &lt;div&gt; &amp; &quot;quotes&quot;");
    expect(out).toContain("--grep &quot;&lt;a&gt;&quot;");
  });
});

describe("renderHtml — diagnosis column (isolation)", () => {
  const diagnosed: FlakeReport[] = [
    { ...reports[0], diagnosis: "order-dependent" } as FlakeReport,
    { ...reports[1] } as FlakeReport,
  ];

  it("adds the column, the cell and the legend when isolation ran", () => {
    const out = renderHtml(diagnosed, { ...meta, isolation: { enabled: true, runs: 5 } });
    expect(out).toContain(">Diagnosis</th>");
    expect(out).toContain("⇄ Order-dependent");
    expect(out).toContain("passed every run alone");
    expect(out).toContain("on · 5 runs each");
  });

  it("omits the column, cells and legend entirely when nothing was diagnosed", () => {
    const out = renderHtml(reports, meta);
    // Assert on the rendered column header / cells, not the bare word — the
    // stylesheet always carries the (unused) diagnosis rules and their comment.
    expect(out).not.toContain(">Diagnosis</th>");
    expect(out).not.toContain('<span class="dx');
    expect(out).not.toContain("passed every run alone");
    expect(out).toContain("<dt>Isolation</dt><dd>off</dd>");
  });
});

describe("renderHtml — crashed runs", () => {
  it("explains a shrunken denominator when runs crashed", () => {
    const out = renderHtml(reports, {
      ...meta,
      usableRuns: 8,
      crashedRuns: 2,
      crashes: [
        { runIndex: 3, reason: "no results file at /tmp/run-003.xml", timedOut: false },
        { runIndex: 7, reason: "timed out after 300000ms", timedOut: true },
      ],
    });
    expect(out).toContain("Crashed runs");
    expect(out).toContain("Run 3 — no results file at /tmp/run-003.xml");
    expect(out).toContain("Run 7 (timed out)");
    expect(out).toContain("they are not test failures");
  });

  it("omits the crashed section when every run was usable", () => {
    expect(renderHtml(reports, meta)).not.toContain("Crashed runs");
  });
});
