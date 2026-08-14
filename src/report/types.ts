/**
 * Shapes shared by the report renderers (terminal / html / json).
 *
 * A leaf inside `report/`: it describes the *frame* around the per-test
 * `FlakeReport[]` — the sweep-level facts a reader needs to interpret the numbers.
 * The terminal only needs the run counts; the file/machine exports are read
 * detached from the session that produced them, so they need provenance too
 * (what command ran, how many times, when, what blew up).
 */

/** Sweep-level counts that frame any report (not per-test). */
export interface ReportMeta {
  usableRuns: number;
  crashedRuns: number;
  totalRuns: number;
}

/** One crashed run, surfaced so an export explains a shrunken denominator. */
export interface CrashInfo {
  runIndex: number;
  /** Why we classified the run as crashed (runner blew up / unusable results). */
  reason?: string;
  timedOut: boolean;
}

/**
 * {@link ReportMeta} plus the provenance an out-of-band report needs.
 *
 * Terminal output is read in the terminal that produced it, so context is implicit.
 * An HTML/PDF file or a JSON blob in CI is read later and elsewhere — it has to
 * carry its own answer to "what produced these numbers?".
 */
export interface ExportMeta extends ReportMeta {
  /** ISO timestamp of when the report was generated. */
  generatedAt: string;
  /** The test command that was swept (`config.command`). */
  command: string;
  /** N — how many full-suite runs were requested. */
  times: number;
  /** Isolation pass: whether it was enabled, and R. */
  isolation: { enabled: boolean; runs: number };
  /** Every run that crashed, so a reader can see why `usableRuns < totalRuns`. */
  crashes: CrashInfo[];
}
