/**
 * Parser registry — the one place that maps a `reporter` name to its adapter.
 *
 * The engine asks for a parser by name and gets a {@link ResultParser} back; it
 * never imports a concrete parser. Adding a reporter is a one-line change here.
 */
import { junitParser } from "./junit.js";
import type { ReporterName, ResultParser } from "./types.js";

const PARSERS: Partial<Record<ReporterName, ResultParser>> = {
  junit: junitParser,
  // "json" is on the V1 roadmap (SPEC §5) — not yet implemented.
};

/**
 * Look up the parser for a reporter. Throws a clear, actionable error for an
 * unknown or not-yet-implemented reporter (config validation already restricts
 * `reporter` to the known names, so this mainly catches "json" pre-Phase-N).
 */
export function getParser(reporter: string): ResultParser {
  const parser = PARSERS[reporter as ReporterName];
  if (!parser) {
    const known = Object.keys(PARSERS).join(", ");
    throw new Error(
      `No parser available for reporter "${reporter}". Supported reporters: ${known}.`,
    );
  }
  return parser;
}

export type { ResultParser, ReporterName } from "./types.js";
