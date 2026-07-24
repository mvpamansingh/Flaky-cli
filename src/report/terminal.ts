import boxen from "boxen";
import chalk, { type ChalkInstance } from "chalk";
import Table from "cli-table3";
import { palette } from "../theme/palette.js";
import type { FlakeReport } from "../types.js";

/**
 * Themed terminal report (SPEC §7, Xenolith). Presentation only — it consumes the
 * worst-first `FlakeReport[]` that `core/correlate.ts` already produced and turns it
 * into a string. It NEVER sorts, classifies, or does I/O; the command writes the
 * returned string to stdout (the report is the tool's *result*, rule #5 / SPEC §5).
 *
 * `color` gates all ANSI/box output (CLAUDE.md rule #5). The caller decides it from
 * `isInteractive(process.stdout)`; when false we return the plain, pipe-safe text —
 * byte-for-byte the format `flaky run` emitted before Phase 6, so pipes and `--json`
 * prep are unaffected.
 */

/** Sweep-level counts that frame the report (not per-test). */
export interface ReportMeta {
  usableRuns: number;
  crashedRuns: number;
  totalRuns: number;
}

export function renderReport(
  reports: FlakeReport[],
  meta: ReportMeta,
  opts: { color: boolean },
): string {
  return opts.color ? renderThemed(reports, meta) : renderPlain(reports, meta);
}

// ── Counts shared by both renderers ────────────────────────────────────────

interface Counts {
  flaky: FlakeReport[];
  failing: FlakeReport[];
  stable: FlakeReport[];
}

function tally(reports: FlakeReport[]): Counts {
  return {
    flaky: reports.filter((r) => r.classification === "flaky"),
    failing: reports.filter((r) => r.classification === "consistently-failing"),
    stable: reports.filter((r) => r.classification === "stable-pass"),
  };
}

function pct(rate: number): number {
  return Math.round(rate * 100);
}

// ── Plain renderer (non-TTY / piped) ────────────────────────────────────────
//
// Preserves the exact pre-Phase-6 text so `flaky run | cat` / redirected output
// stays stable and free of ANSI.

function renderPlain(reports: FlakeReport[], meta: ReportMeta): string {
  const { flaky, failing, stable } = tally(reports);
  const lines: string[] = [];

  lines.push("");
  const crashNote = meta.crashedRuns > 0 ? `, ${meta.crashedRuns} crashed` : "";
  lines.push(`Sweep complete: ${meta.usableRuns}/${meta.totalRuns} runs usable${crashNote}.`);
  lines.push(
    `${reports.length} tests · ${flaky.length} flaky · ${failing.length} consistently-failing · ${stable.length} stable.`,
  );

  if (flaky.length > 0) {
    lines.push("");
    lines.push("⚠ Flaky anomalies (worst first):");
    for (const r of flaky) {
      lines.push(`  • ${r.testId} — ${r.fails}/${r.runs} fails (${pct(r.flakeRate)}%)`);
    }
  }
  if (failing.length > 0) {
    lines.push("");
    lines.push("✗ Consistently failing (likely real bugs, not flakes):");
    for (const r of failing) {
      lines.push(`  • ${r.testId} — ${r.fails}/${r.runs} fails`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// ── Themed renderer (TTY) ───────────────────────────────────────────────────

/** Row/label color per classification (SPEC §7 palette). */
function colorFor(classification: FlakeReport["classification"]): ChalkInstance {
  switch (classification) {
    case "flaky":
      return chalk.hex(palette.flaky); // amber
    case "consistently-failing":
      return chalk.hex(palette.broken); // hot magenta
    default:
      return chalk.hex(palette.secondary); // alien green
  }
}

/** Xenolith verdict label per classification. */
function verdictLabel(classification: FlakeReport["classification"]): string {
  switch (classification) {
    case "flaky":
      return "◈ ANOMALY";
    case "consistently-failing":
      return "✖ BROKEN";
    default:
      return "✓ STABLE";
  }
}

/** Signal-instability bar, e.g. `▓▓▓░░ 60%`. */
function flakeBar(rate: number, width = 5): string {
  const filled = Math.max(0, Math.min(width, Math.round(rate * width)));
  return `${"▓".repeat(filled)}${"░".repeat(width - filled)} ${pct(rate)}%`;
}

function renderThemed(reports: FlakeReport[], meta: ReportMeta): string {
  const brand = chalk.hex(palette.brand);
  const dim = chalk.hex(palette.dim);
  const head = (label: string) => brand.bold(label);

  const table = new Table({
    head: [head("Verdict"), head("Specimen"), head("Runs"), head("Instability")],
    // We inject our own truecolor via chalk, so disable cli-table3's own styling.
    style: { head: [], border: [] },
    colWidths: [13, 50, 12, 16],
    wordWrap: true,
  });

  for (const r of reports) {
    const paint = colorFor(r.classification);
    table.push([
      paint(verdictLabel(r.classification)),
      paint(r.testId),
      dim(`${r.passes}✓ ${r.fails}✗`),
      paint(flakeBar(r.flakeRate)),
    ]);
  }

  const { flaky, failing, stable } = tally(reports);
  const crashNote = meta.crashedRuns > 0 ? dim(`, ${meta.crashedRuns} crashed`) : "";
  const summary = [
    `${brand.bold("⟁ Sweep complete")} · ${meta.usableRuns}/${meta.totalRuns} runs usable${crashNote}`,
    [
      dim(`${reports.length} specimens`),
      chalk.hex(palette.flaky)(`${flaky.length} anomalies`),
      chalk.hex(palette.broken)(`${failing.length} broken`),
      chalk.hex(palette.secondary)(`${stable.length} stable`),
    ].join(dim(" · ")),
  ].join("\n");

  const box = boxen(summary, {
    padding: 1,
    borderStyle: "round",
    borderColor: palette.brand,
    title: brand("specimen scan"),
    titleAlignment: "center",
  });

  return `\n${box}\n\n${table.toString()}\n`;
}
