import { palette } from "../theme/palette.js";
import type { FlakeReport } from "../types.js";
import { TOOL_NAME, TOOL_VERSION } from "../version.js";
import type { ExportMeta } from "./types.js";

/**
 * `--html` export (SPEC §8) — a single **self-contained** HTML file.
 *
 * Pure: `FlakeReport[]` + {@link ExportMeta} → one string. No fs, no streams; the
 * command writes it (and `report/pdf.ts` feeds the same string to Chromium), which
 * keeps this a presentation leaf and trivially unit-testable.
 *
 * Self-contained is a hard requirement: no CDN CSS, no web fonts, no images. The file
 * has to render from a `file://` URL on a plane and print identically through
 * puppeteer, so everything is inline and the type stack is system fonts only.
 *
 * The theme is the Xenolith palette, read from `theme/palette.ts` (single source of
 * truth — the terminal and this export can't drift). Colors are *status* colors, and
 * per accessibility they never carry meaning alone: every verdict and diagnosis ships
 * an icon **and** a text label, and every instability meter prints its percentage.
 */

export function renderHtml(reports: FlakeReport[], meta: ExportMeta): string {
  const showDiagnosis = reports.some((r) => r.diagnosis);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${TOOL_NAME} ${TOOL_VERSION}">
<title>Flaky Detective — specimen scan</title>
<style>
${styles()}
</style>
</head>
<body>
<main class="scan">
${header(meta)}
${tiles(reports, meta)}
${honesty(meta)}
${table(reports, showDiagnosis)}
${showDiagnosis ? legend() : ""}
${crashes(meta)}
${footer(meta)}
</main>
</body>
</html>
`;
}

// ── Sections ────────────────────────────────────────────────────────────────

function header(meta: ExportMeta): string {
  return `  <header class="masthead">
    <div class="sigil" aria-hidden="true">⟁</div>
    <h1>FLAKY DETECTIVE</h1>
    <p class="tagline">specimen scan report</p>
    <dl class="provenance">
      <div><dt>Command</dt><dd><code>${esc(meta.command)}</code></dd></div>
      <div><dt>Runs</dt><dd>${meta.usableRuns} usable of ${meta.totalRuns}</dd></div>
      <div><dt>Isolation</dt><dd>${
        meta.isolation.enabled ? `on · ${meta.isolation.runs} runs each` : "off"
      }</dd></div>
      <div><dt>Generated</dt><dd>${esc(meta.generatedAt)}</dd></div>
    </dl>
  </header>`;
}

/**
 * KPI row. The big numbers wear the primary ink token; identity is carried by the
 * icon + label + accent rule beside them, never by coloring the value itself.
 */
function tiles(reports: FlakeReport[], meta: ExportMeta): string {
  const n = (c: FlakeReport["classification"]) =>
    reports.filter((r) => r.classification === c).length;

  const cells = [
    { key: "total", icon: "◇", label: "Specimens", value: reports.length },
    { key: "flaky", icon: "◈", label: "Anomalies", value: n("flaky") },
    { key: "broken", icon: "✖", label: "Broken", value: n("consistently-failing") },
    { key: "stable", icon: "✓", label: "Stable", value: n("stable-pass") },
    // Always shown, even at 0 — "0 crashed" is itself information about the sweep.
    { key: "crashed", icon: "⚠", label: "Crashed", value: meta.crashedRuns },
  ];

  return `  <section class="tiles" aria-label="Scan summary">
${cells
  .map(
    (c) => `    <div class="tile tile--${c.key}">
      <span class="tile-icon" aria-hidden="true">${c.icon}</span>
      <span class="tile-value">${c.value}</span>
      <span class="tile-label">${c.label}</span>
    </div>`,
  )
  .join("\n")}
  </section>`;
}

/**
 * The honesty note (CLAUDE.md: "We can only *sample* flakiness, never prove its
 * absence… Say so honestly in the UI"). It matters most here: an exported file gets
 * forwarded to people who never saw the run and could read "0 anomalies" as a
 * guarantee.
 */
function honesty(meta: ExportMeta): string {
  return `  <p class="honesty">
    <strong>This is a statistical statement, not a guarantee.</strong>
    Flakiness can only be sampled: ${meta.usableRuns} run${meta.usableRuns === 1 ? "" : "s"}
    of <code>${esc(meta.command)}</code> found what it found. A test listed as stable here
    may still flake at a rate this sample was too small to catch — raise <code>--times</code>
    to tighten the bound.
  </p>`;
}

function table(reports: FlakeReport[], showDiagnosis: boolean): string {
  if (reports.length === 0) {
    return `  <p class="empty">No specimens recorded — no usable test results in this sweep.</p>`;
  }

  const head = [
    "Verdict",
    "Specimen",
    "Runs",
    "Instability",
    ...(showDiagnosis ? ["Diagnosis"] : []),
  ]
    .map((h) => `<th scope="col">${h}</th>`)
    .join("");

  const rows = reports
    .map((r) => {
      const v = verdict(r.classification);
      const cells = [
        `<td><span class="chip chip--${v.key}">${v.icon} ${v.label}</span></td>`,
        `<td class="specimen">${esc(r.testId)}</td>`,
        `<td class="runs"><span class="pass">${r.passes}✓</span> <span class="fail">${r.fails}✗</span></td>`,
        `<td>${meter(r.flakeRate, v.key)}</td>`,
        ...(showDiagnosis ? [`<td>${diagnosisCell(r.diagnosis)}</td>`] : []),
      ];
      return `      <tr class="row--${v.key}">${cells.join("")}</tr>`;
    })
    .join("\n");

  return `  <section class="results">
    <h2>Specimens <span class="hint">worst first</span></h2>
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function legend(): string {
  return `  <p class="legend">
    <span><strong>⇄ Order-dependent</strong> — passed every run alone, so the cause is
    outside the test (shared state / ordering).</span>
    <span><strong>⚛ Internally nondeterministic</strong> — failed on its own too, so the
    cause is inside the test (randomness / timing).</span>
    <span><strong>? Unknown</strong> — isolation could not produce a definitive outcome.</span>
  </p>`;
}

function crashes(meta: ExportMeta): string {
  if (meta.crashes.length === 0) return "";
  const items = meta.crashes
    .map(
      (c) =>
        `      <li>Run ${c.runIndex}${c.timedOut ? " (timed out)" : ""} — ${esc(
          c.reason ?? "no usable results",
        )}</li>`,
    )
    .join("\n");
  return `  <section class="crashes">
    <h2>Crashed runs</h2>
    <p class="hint">The runner itself failed to produce usable results in these runs, so they
    were excluded from correlation — they are not test failures.</p>
    <ul>
${items}
    </ul>
  </section>`;
}

function footer(meta: ExportMeta): string {
  return `  <footer>
    <span>${TOOL_NAME} v${TOOL_VERSION} · ${esc(meta.command)} × ${meta.times}</span>
    <span>Runs entirely locally · sends nothing anywhere</span>
  </footer>`;
}

// ── Cells ───────────────────────────────────────────────────────────────────

interface Verdict {
  key: "flaky" | "broken" | "stable";
  icon: string;
  label: string;
}

function verdict(classification: FlakeReport["classification"]): Verdict {
  switch (classification) {
    case "flaky":
      return { key: "flaky", icon: "◈", label: "ANOMALY" };
    case "consistently-failing":
      return { key: "broken", icon: "✖", label: "BROKEN" };
    default:
      return { key: "stable", icon: "✓", label: "STABLE" };
  }
}

/**
 * Instability meter — the HTML twin of the terminal's `▓▓▓░░ 60%` bar. The fill is
 * anchored to the track's baseline with a rounded data-end, and the percentage is
 * printed as text so the value never depends on reading the color or the width.
 */
function meter(rate: number, key: Verdict["key"]): string {
  const percent = Math.round(rate * 100);
  return `<div class="meter" role="img" aria-label="instability ${percent} percent">
        <span class="meter-track"><span class="meter-fill meter-fill--${key}" style="width:${percent}%"></span></span>
        <span class="meter-value">${percent}%</span>
      </div>`;
}

function diagnosisCell(diagnosis: FlakeReport["diagnosis"]): string {
  switch (diagnosis) {
    case "order-dependent":
      return `<span class="dx dx--order">⇄ Order-dependent</span>`;
    case "internally-nondeterministic":
      return `<span class="dx dx--internal">⚛ Internally nondeterministic</span>`;
    case "unknown":
      return `<span class="dx dx--unknown">? Unknown</span>`;
    default:
      return `<span class="dx dx--none">—</span>`;
  }
}

// ── Escaping ────────────────────────────────────────────────────────────────

/**
 * Escape text before it lands in the document.
 *
 * Load-bearing, not hygiene theater: test names and file paths are arbitrary strings
 * from the user's suite. A test named `renders <div> & escapes "quotes"` would
 * otherwise inject markup and silently corrupt the report — the same string also
 * flows into the PDF via Chromium.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Theme ───────────────────────────────────────────────────────────────────

/** Xenolith CSS, built from `theme/palette.ts` so the export can't drift from the terminal. */
function styles(): string {
  return `:root {
  --brand: ${palette.brand};
  --violet: ${palette.gradientTo};
  --stable: ${palette.secondary};
  --flaky: ${palette.flaky};
  --broken: ${palette.broken};
  --ink: ${palette.ink};
  --dim: ${palette.dim};
  --muted: ${palette.muted};
  --surface: ${palette.surface};
  --raised: ${palette.surfaceRaised};
  --border: ${palette.border};
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  background: var(--surface);
  /* A faint bioluminescent bloom behind the masthead — pure CSS, no assets. */
  background-image: radial-gradient(ellipse 90% 60% at 50% -10%, ${palette.brand}1F, transparent 70%);
  background-repeat: no-repeat;
  color: var(--ink);
  font: 14px/1.6 var(--mono);
}
.scan { max-width: 68rem; margin: 0 auto; }

/* Masthead */
.masthead { text-align: center; margin-bottom: 2.5rem; }
.sigil { font-size: 2rem; color: var(--brand); line-height: 1; }
.masthead h1 {
  margin: .35rem 0 0;
  font-size: clamp(1.6rem, 5vw, 2.6rem);
  letter-spacing: .22em;
  font-weight: 700;
  color: var(--brand);
}
@supports (background-clip: text) or (-webkit-background-clip: text) {
  .masthead h1 {
    background: linear-gradient(90deg, var(--brand), var(--violet));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}
.tagline { margin: .35rem 0 1.75rem; color: var(--dim); letter-spacing: .35em; font-size: .75rem; text-transform: uppercase; }
.provenance {
  display: grid; gap: .5rem 1.5rem; margin: 0;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  text-align: left; border-top: 1px solid var(--border); padding-top: 1rem;
}
/* The command is the longest value by far — give it its own full-width row so it
   doesn't wrap to three lines while the other cells sit half empty. */
.provenance > div:first-child { grid-column: 1 / -1; }
.provenance > div { display: flex; gap: .6rem; min-width: 0; }
.provenance dt { color: var(--muted); text-transform: uppercase; font-size: .7rem; letter-spacing: .12em; padding-top: .2rem; flex: 0 0 6.5rem; }
.provenance dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* KPI tiles */
.tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); margin-bottom: 2rem; }
.tile {
  background: var(--raised); border: 1px solid var(--border); border-radius: 10px;
  padding: 1rem; display: grid; grid-template-columns: auto 1fr; gap: 0 .6rem; align-items: baseline;
  border-top: 2px solid var(--border);
}
.tile-icon { font-size: .9rem; }
.tile-value { font-size: 1.9rem; font-weight: 700; color: var(--ink); line-height: 1.1; }
.tile-label { grid-column: 2; color: var(--dim); font-size: .72rem; text-transform: uppercase; letter-spacing: .12em; }
.tile--total { border-top-color: var(--brand); } .tile--total .tile-icon { color: var(--brand); }
.tile--flaky { border-top-color: var(--flaky); } .tile--flaky .tile-icon { color: var(--flaky); }
.tile--broken { border-top-color: var(--broken); } .tile--broken .tile-icon { color: var(--broken); }
.tile--stable { border-top-color: var(--stable); } .tile--stable .tile-icon { color: var(--stable); }
.tile--crashed .tile-icon { color: var(--muted); }

/* Honesty note */
.honesty {
  border: 1px solid ${palette.brand}33; border-left: 3px solid var(--brand);
  background: ${palette.brand}0D; border-radius: 8px; padding: .9rem 1.1rem;
  color: var(--dim); font-size: .82rem; margin: 0 0 2rem;
}
.honesty strong { color: var(--ink); }

/* Results table */
.results h2, .crashes h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .2em; color: var(--brand); font-weight: 600; margin: 0 0 .75rem; }
.hint { color: var(--muted); text-transform: none; letter-spacing: 0; font-size: .72rem; font-weight: 400; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
thead th {
  text-align: left; padding: .6rem .75rem; background: var(--raised);
  color: var(--brand); font-size: .68rem; letter-spacing: .14em; text-transform: uppercase;
  border-bottom: 1px solid var(--border); font-weight: 600;
}
tbody td { padding: .7rem .75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
tbody tr:hover td { background: ${palette.brand}08; }
.specimen { color: var(--ink); overflow-wrap: anywhere; }
.runs { white-space: nowrap; color: var(--dim); }
.runs .pass { color: var(--stable); } .runs .fail { color: var(--broken); }

/* Verdict chips — icon + label, so the state never rests on color alone. */
.chip {
  display: inline-block; white-space: nowrap; border: 1px solid; border-radius: 999px;
  padding: .15rem .6rem; font-size: .7rem; letter-spacing: .1em; font-weight: 700;
}
.chip--flaky { color: var(--flaky); border-color: ${palette.flaky}59; background: ${palette.flaky}1A; }
.chip--broken { color: var(--broken); border-color: ${palette.broken}59; background: ${palette.broken}1A; }
.chip--stable { color: var(--stable); border-color: ${palette.secondary}59; background: ${palette.secondary}1A; }

/* Instability meter */
.meter { display: flex; align-items: center; gap: .55rem; }
.meter-track { display: block; position: relative; width: 6.5rem; height: 7px; border-radius: 999px; background: var(--border); overflow: hidden; }
.meter-fill { display: block; height: 100%; border-radius: 999px; min-width: 0; }
.meter-fill--flaky { background: var(--flaky); }
.meter-fill--broken { background: var(--broken); }
.meter-fill--stable { background: var(--stable); }
.meter-value { color: var(--dim); font-variant-numeric: tabular-nums; font-size: .78rem; }

/* Diagnosis */
.dx { white-space: nowrap; font-size: .76rem; }
.dx--order { color: var(--brand); }
.dx--internal { color: var(--flaky); }
.dx--unknown, .dx--none { color: var(--muted); }
.legend { display: grid; gap: .3rem; margin: 1rem 0 0; color: var(--muted); font-size: .74rem; }
.legend strong { color: var(--dim); }

/* Crashes + footer */
.crashes { margin-top: 2.5rem; }
.crashes ul { margin: .5rem 0 0; padding-left: 1.2rem; color: var(--dim); font-size: .8rem; }
.empty { color: var(--muted); text-align: center; padding: 2rem 0; }
footer {
  margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; justify-content: space-between;
  color: var(--muted); font-size: .7rem; letter-spacing: .08em;
}
code { color: var(--brand); font-family: var(--mono); }

/* Print / PDF (puppeteer renders with print media). Keep the Xenolith surface —
   the theme is the point — and never split a specimen row across pages. */
@page { margin: 12mm; }
@media print {
  body { padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .scan { max-width: none; }
  tbody tr, .tile, .honesty { break-inside: avoid; }
  thead { display: table-header-group; }
  tbody tr:hover td { background: none; }
}`;
}
