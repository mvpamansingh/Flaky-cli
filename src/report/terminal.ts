import boxen from "boxen";
import chalk, { type ChalkInstance } from "chalk";
import Table from "cli-table3";
import { palette } from "../theme/palette.js";
import type { FlakeReport } from "../types.js";
import type { ReportMeta } from "./types.js";

/**
 * Themed terminal report (SPEC §7, Xenolith). Presentation only — it consumes the
 * worst-first `FlakeReport[]` that `core/correlate.ts` already produced and turns it
 * into a string. It NEVER sorts, classifies, or does I/O; the command writes the
 * returned string to stdout (the report is the tool's *result*, rule #5 / SPEC §5).
 *
 * `color` gates all ANSI/box output (CLAUDE.md rule #5). The caller decides it from
 * `isInteractive(process.stdout)`; when false we return plain, ANSI-free, pipe-safe
 * text. That plain form was byte-identical to the pre-Phase-6 output until Phase 9
 * appended the sampling caveat — the one deliberate break, because CLAUDE.md requires
 * the honesty note in the UI and a piped report is exactly the copy that gets pasted
 * into a ticket without its context.
 */

// `ReportMeta` now lives in `report/types.ts` (shared with the html/json exports,
// which extend it into `ExportMeta`). Re-exported here so existing importers — and
// the mental model "the terminal renderer takes reports + meta" — stay intact.
export type { ReportMeta };

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

/**
 * The sampling caveat (CLAUDE.md: "We can only *sample* flakiness, never prove its
 * absence… Say so honestly in the UI").
 *
 * ONE sentence shared by both renderers so the plain and themed views can never
 * disagree about how strong a claim we're making — the same reason the HTML export
 * builds its longer note from the same facts. It quotes `usableRuns` rather than the
 * requested N because that is the sample the numbers above it actually came from: a
 * sweep where 18 of 20 runs crashed makes a much weaker statement than one where none
 * did, and the reader deserves the honest denominator.
 *
 * Deliberately contains no `[` — the plain renderer's `[diagnosis]` tags are asserted
 * by absence in tests/terminal.test.ts, and a bracket here would make that test lie.
 */
function samplingCaveat(meta: ReportMeta): string {
  const runs = `${meta.usableRuns} run${meta.usableRuns === 1 ? "" : "s"}`;
  return `Note: this is a sample, not a proof — based on ${runs}. A test called stable here can still flake below this sweep's resolution; raise --times to tighten the bound.`;
}

/** Plain `[diagnosis]` tag for the piped output; empty when not diagnosed. */
function diagnosisTag(diagnosis: FlakeReport["diagnosis"]): string {
  return diagnosis ? ` [${diagnosis}]` : "";
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
      lines.push(
        `  • ${r.testId} — ${r.fails}/${r.runs} fails (${pct(r.flakeRate)}%)${diagnosisTag(r.diagnosis)}`,
      );
    }
  }
  if (failing.length > 0) {
    lines.push("");
    lines.push("✗ Consistently failing (likely real bugs, not flakes):");
    for (const r of failing) {
      lines.push(`  • ${r.testId} — ${r.fails}/${r.runs} fails`);
    }
  }

  // Footnote position, deliberately: it's the last thing before the prompt, so it
  // can't be scrolled past unread the way a header can.
  lines.push("");
  lines.push(samplingCaveat(meta));

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

/** Themed diagnosis cell: short Xenolith label, colored by cause. */
function diagnosisCell(diagnosis: FlakeReport["diagnosis"], dim: ChalkInstance): string {
  switch (diagnosis) {
    case "order-dependent":
      // External cause — cyan, the "signal comes from elsewhere" color.
      return chalk.hex(palette.brand)("⇄ ORDER");
    case "internally-nondeterministic":
      // Cause lives inside the test — amber, same family as the flaky verdict.
      return chalk.hex(palette.flaky)("⚛ INTERNAL");
    case "unknown":
      return dim("? UNKNOWN");
    default:
      return dim("—"); // not diagnosed (isolation off, or not a flaky row)
  }
}

function renderThemed(reports: FlakeReport[], meta: ReportMeta): string {
  const brand = chalk.hex(palette.brand);
  const dim = chalk.hex(palette.dim);
  const head = (label: string) => brand.bold(label);

  // Only show the Diagnosis column when isolation actually ran (any report carries
  // a diagnosis) — otherwise it'd be a column of "—" that just adds noise.
  const showDiagnosis = reports.some((r) => r.diagnosis);

  const table = new Table({
    head: showDiagnosis
      ? [head("Verdict"), head("Specimen"), head("Runs"), head("Instability"), head("Diagnosis")]
      : [head("Verdict"), head("Specimen"), head("Runs"), head("Instability")],
    // We inject our own truecolor via chalk, so disable cli-table3's own styling.
    style: { head: [], border: [] },
    colWidths: showDiagnosis ? [13, 40, 11, 15, 15] : [13, 50, 12, 16],
    wordWrap: true,
  });

  for (const r of reports) {
    const paint = colorFor(r.classification);
    const row = [
      paint(verdictLabel(r.classification)),
      paint(r.testId),
      dim(`${r.passes}✓ ${r.fails}✗`),
      paint(flakeBar(r.flakeRate)),
    ];
    if (showDiagnosis) row.push(diagnosisCell(r.diagnosis, dim));
    table.push(row);
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

  const legend = showDiagnosis
    ? `\n${dim("⇄ ORDER = fails only alongside other tests (shared state / ordering)  ·  ⚛ INTERNAL = fails on its own (randomness / timing)")}\n`
    : "";

  // Dim, not amber: the caveat frames the whole report, so it must not compete with
  // the status colors that carry the actual findings.
  const caveat = dim(samplingCaveat(meta));

  return `\n${box}\n\n${table.toString()}\n${legend}\n${caveat}\n`;
}
