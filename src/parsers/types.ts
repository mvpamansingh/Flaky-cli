/**
 * The adapter seam that makes the tool framework-agnostic (SPEC §5).
 *
 * Every reporter format (JUnit XML now, JSON later) implements this one
 * interface: raw file contents in, normalized `TestResult[]` out. The engine
 * never learns a new format — it only ever holds a `ResultParser`, so new
 * reporters slot in behind this interface without the core changing.
 */
import type { TestResult } from "../types.js";

/** Reporter formats we can parse. Grows as adapters are added. */
export type ReporterName = "junit" | "json";

export interface ResultParser {
  name: ReporterName;
  /**
   * Parse one run's raw results-file contents into normalized results.
   *
   * Throws if the contents are not valid for this format (SPEC §6 treats an
   * *unparseable* results file as a crashed run, distinct from a run where the
   * tests merely failed). Returning `[]` means "parsed fine, no tests" — which
   * is a real, if unusual, outcome, not a parse failure.
   */
  parse(fileContents: string): TestResult[];
}
