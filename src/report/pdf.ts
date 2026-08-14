import { createRequire } from "node:module";
import { ensureParentDir } from "../utils/outfile.js";

/**
 * `--pdf` export (SPEC §8) — renders the HTML report to PDF through puppeteer.
 *
 * **puppeteer is LAZY and OPTIONAL.** It bundles a ~150MB Chromium, which nobody who
 * never exports a PDF should pay for, so it is not a dependency of this package (only
 * an optional peer) and is imported *inside* the function via `await import`. Nothing
 * about `flaky run` touches Chromium unless `--pdf` is passed.
 *
 * Consequently a missing puppeteer is a **documented, non-fatal outcome**, not an
 * error: we return `puppeteer-missing` and the caller prints the install hint and
 * still writes the HTML (SPEC §8). A puppeteer that *is* installed but fails to
 * launch or render is a genuine failure and is reported as `render-failed`.
 *
 * This module does I/O by nature (spawning a browser, writing a file), which is why
 * it stays separate from the pure `report/html.ts`.
 */

export type PdfResult =
  | { ok: true; path: string }
  | { ok: false; reason: "puppeteer-missing"; message: string }
  | { ok: false; reason: "render-failed"; message: string };

export interface PdfOptions {
  /** The rendered HTML report (from `renderHtml`) — the PDF's only input. */
  html: string;
  /** Absolute path to write the PDF to. */
  path: string;
}

/**
 * The slice of puppeteer's API we use, declared structurally.
 *
 * We cannot `import type { Browser } from "puppeteer"` — the package legitimately
 * isn't installed, so its types aren't resolvable and `tsc` would fail on a clean
 * checkout. This keeps the module type-safe without a build-time dependency.
 */
interface PuppeteerLike {
  launch(options?: Record<string, unknown>): Promise<BrowserLike>;
}
interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface PageLike {
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
  pdf(options: Record<string, unknown>): Promise<unknown>;
}

export async function writePdfReport({ html, path }: PdfOptions): Promise<PdfResult> {
  let puppeteer: PuppeteerLike;
  try {
    puppeteer = await loadPuppeteer();
  } catch (err) {
    if (isModuleNotFound(err)) {
      return {
        ok: false,
        reason: "puppeteer-missing",
        message: "puppeteer is not installed — run `npm i puppeteer` to enable PDF export.",
      };
    }
    return { ok: false, reason: "render-failed", message: (err as Error).message };
  }

  let browser: BrowserLike | undefined;
  try {
    await ensureParentDir(path);
    browser = await puppeteer.launch();
    const page = await browser.newPage();
    // The report is a self-contained string with no external requests, so there is
    // nothing to wait for beyond parsing + layout.
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path,
      format: "A4",
      // Load-bearing for a dark theme: without it Chromium drops every background
      // and the Xenolith report prints as light-on-white, i.e. unreadable.
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, reason: "render-failed", message: (err as Error).message };
  } finally {
    // Never leave a Chromium process behind, even if rendering threw.
    await browser?.close().catch(() => {});
  }
}

/**
 * Import puppeteer at runtime only.
 *
 * The specifier goes through a variable on purpose: a literal would let the bundler
 * try to resolve (and warn about) a package that is intentionally absent. Handles both
 * the ESM namespace and the CJS `default` interop shape.
 */
async function loadPuppeteer(): Promise<PuppeteerLike> {
  const specifier = "puppeteer";
  const mod: unknown = await import(specifier);
  const candidate = mod as { default?: PuppeteerLike } & Partial<PuppeteerLike>;
  const resolved = typeof candidate.launch === "function" ? candidate : candidate.default;
  if (!resolved || typeof resolved.launch !== "function") {
    throw new Error("puppeteer was found but does not expose launch() — unexpected version?");
  }
  return resolved as PuppeteerLike;
}

/**
 * Distinguish "puppeteer isn't installed" (→ graceful fallback) from "puppeteer is
 * installed but threw while loading" (→ a real error). Getting this wrong in the
 * missing direction is exactly the hard failure SPEC §8 forbids, so it's layered:
 *
 *   1. Node's own error codes — precise, and the normal case.
 *   2. Message shape — covers wording differences across Node versions.
 *   3. Ask the resolver directly — the authority. A bundler or test runner (Vite's
 *      module runner, for one) intercepts dynamic imports and reports an unresolvable
 *      package in its own words with no recognizable code, and we must not read that
 *      as "your puppeteer is broken".
 *
 * Layer 3 is only consulted after 1 and 2 miss, so a genuinely installed-but-broken
 * puppeteer still resolves and is correctly reported as `render-failed`.
 */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;

  const message = (err as Error | undefined)?.message ?? "";
  if (/cannot find (package|module)|module not found|failed to (load|resolve)/i.test(message)) {
    return true;
  }

  return !isResolvable("puppeteer");
}

/** Can this specifier be resolved from here at all? */
function isResolvable(specifier: string): boolean {
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * The HTML path to fall back to when a PDF was requested but puppeteer is missing.
 *
 * SPEC §8 says we must "still produce the HTML", so a bare `--pdf out/report.pdf`
 * degrades to `out/report.html` — same directory and basename, so it's obvious which
 * file replaced which. Pure string math, unit-tested.
 */
export function htmlFallbackPath(pdfPath: string): string {
  return `${pdfPath.replace(/\.pdf$/i, "")}.html`;
}
