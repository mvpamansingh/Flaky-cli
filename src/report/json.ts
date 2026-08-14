import type { FlakeReport } from "../types.js";
import { TOOL_NAME, TOOL_VERSION } from "../version.js";
import type { CrashInfo, ExportMeta } from "./types.js";

/**
 * `--json` output — the machine-readable face of the tool (CLAUDE.md rule #5).
 *
 * Pure: data in → string out, no I/O and no stream access. The command writes the
 * returned string to **stdout** and keeps every log on stderr, so `flaky run --json`
 * is safe to pipe straight into `jq` / a CI script.
 *
 * The envelope is **versioned** ({@link JSON_SCHEMA_VERSION}) because this is a
 * contract other programs will depend on — V2's `--fail-on-flake`, a GitHub Action,
 * a dashboard. Adding a field is backwards-compatible and does NOT bump the version;
 * removing/renaming one, or changing a field's meaning or type, does.
 */

/** Envelope version. Bump only on a breaking change (see module docs). */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonSweep {
  /** The test command that was run, verbatim from the config. */
  command: string;
  /** N — how many full-suite runs were requested. */
  times: number;
  /** How many actually executed (equals `times` unless the sweep aborted). */
  totalRuns: number;
  /** Runs that produced usable results — the correlation denominator. */
  usableRuns: number;
  crashedRuns: number;
  crashes: CrashInfo[];
}

export interface JsonCounts {
  /** Distinct tests seen across all usable runs. */
  tests: number;
  flaky: number;
  consistentlyFailing: number;
  stablePass: number;
}

/** The exact shape written to stdout under `--json`. */
export interface JsonReport {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  sweep: JsonSweep;
  isolation: { enabled: boolean; runs: number };
  counts: JsonCounts;
  /** Per-test verdicts, worst-first (the order `correlate` produced). */
  reports: FlakeReport[];
}

/**
 * Build the JSON envelope. Exported separately from {@link renderJson} so tests (and
 * future in-process consumers) can assert on the structure without re-parsing text.
 *
 * `reports` is passed through in the order given — `correlate` already sorted it
 * worst-first and nothing downstream may re-sort (SPEC §5).
 */
export function buildJsonReport(reports: FlakeReport[], meta: ExportMeta): JsonReport {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    generatedAt: meta.generatedAt,
    sweep: {
      command: meta.command,
      times: meta.times,
      totalRuns: meta.totalRuns,
      usableRuns: meta.usableRuns,
      crashedRuns: meta.crashedRuns,
      crashes: meta.crashes,
    },
    isolation: meta.isolation,
    counts: {
      tests: reports.length,
      flaky: count(reports, "flaky"),
      consistentlyFailing: count(reports, "consistently-failing"),
      stablePass: count(reports, "stable-pass"),
    },
    reports,
  };
}

/**
 * Serialize the envelope for stdout.
 *
 * Pretty-printed (2 spaces) because a human reads this too when eyeballing CI logs,
 * and every JSON consumer is whitespace-insensitive. One trailing newline — standard
 * for CLI output and transparent to `jq` — and nothing else on the stream.
 */
export function renderJson(reports: FlakeReport[], meta: ExportMeta): string {
  return `${JSON.stringify(buildJsonReport(reports, meta), null, 2)}\n`;
}

function count(reports: FlakeReport[], classification: FlakeReport["classification"]): number {
  return reports.filter((r) => r.classification === classification).length;
}
