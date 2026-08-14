import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { htmlFallbackPath, writePdfReport } from "../src/report/pdf.js";

/**
 * Tests for the Phase 8 `--pdf` export.
 *
 * We can't render a real PDF here — puppeteer is deliberately NOT a dependency of
 * this package (it bundles ~150MB of Chromium; SPEC §8 makes it optional and lazy).
 * That absence is exactly what makes the important path testable: the graceful
 * degradation SPEC §8 mandates ("print a friendly hint and still produce the HTML").
 */

/** Is puppeteer actually installed in this checkout? */
function puppeteerInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve("puppeteer");
    return true;
  } catch {
    return false;
  }
}

describe("htmlFallbackPath", () => {
  it("swaps a .pdf extension for .html, keeping directory and basename", () => {
    expect(htmlFallbackPath("/tmp/out/flaky-report.pdf")).toBe("/tmp/out/flaky-report.html");
  });

  it("is case-insensitive about the extension", () => {
    expect(htmlFallbackPath("C:\\reports\\Scan.PDF")).toBe("C:\\reports\\Scan.html");
  });

  it("appends .html when the path has no .pdf extension", () => {
    expect(htmlFallbackPath("/tmp/report")).toBe("/tmp/report.html");
  });

  it("leaves dots inside the basename alone", () => {
    expect(htmlFallbackPath("/tmp/flaky.2026-08-13.pdf")).toBe("/tmp/flaky.2026-08-13.html");
  });
});

describe("writePdfReport — puppeteer not installed", () => {
  // Guarded so the suite stays honest if someone later installs puppeteer locally:
  // then this path genuinely can't happen and the case is skipped rather than failing.
  it.skipIf(puppeteerInstalled())(
    "degrades gracefully with an actionable install hint instead of throwing",
    async () => {
      const result = await writePdfReport({
        html: "<!doctype html><title>x</title>",
        // Never reached — the lazy import fails before any file is touched.
        path: "should-never-be-written.pdf",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return; // narrow for TS
      expect(result.reason).toBe("puppeteer-missing");
      expect(result.message).toContain("npm i puppeteer");
    },
  );
});
