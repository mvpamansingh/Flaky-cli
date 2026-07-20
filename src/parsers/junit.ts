/**
 * JUnit XML → normalized `TestResult[]`.
 *
 * JUnit XML is the cross-language de-facto standard (Vitest/Jest reporters,
 * `pytest --junitxml`, gotestsum, Mocha, …), which is why it's the V1 adapter.
 * We parse defensively rather than assume one tool's exact shape:
 *
 *   - Root may be `<testsuites>` (many suites) OR a single top-level
 *     `<testsuite>` (pytest emits this) — we accept both.
 *   - fast-xml-parser collapses a lone `<testsuite>`/`<testcase>` into an object
 *     instead of a one-element array, so we force those tags to arrays.
 *   - A `<testcase>` is a failure/error if it has a nested `<failure>`/`<error>`,
 *     a skip if it has `<skipped>`, otherwise a pass. We only have pass/fail/skip
 *     (SPEC §5), so JUnit's failure-vs-error distinction both map to `fail`.
 *   - `time` attributes are SECONDS; we normalize to milliseconds.
 *
 * Our fixture's Vitest XML uses `classname`=file and `name`=test with NO nested
 * describe/suite, so `suite` is usually absent — {@link buildId} handles that.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Status, TestResult } from "../types.js";
import type { ResultParser } from "./types.js";

const ATTR_PREFIX = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  // Force these to arrays so we never branch on "one vs many" — a single suite
  // or single testcase would otherwise parse to a bare object.
  isArray: (name) => name === "testsuite" || name === "testcase",
  // Keep attribute values as raw strings; we coerce the few we need ourselves
  // (test names like "0.3" must not silently become numbers).
  parseAttributeValue: false,
  trimValues: true,
});

/**
 * Build the stable cross-run identity for a test (SPEC §5).
 * `${file} :: ${suite} > ${name}` when a suite is known; collapses to
 * `${file} :: ${name}` when it isn't (the common Vitest-without-describe case).
 */
export function buildId(file: string, suite: string | undefined, name: string): string {
  return suite ? `${file} :: ${suite} > ${name}` : `${file} :: ${name}`;
}

function parseJunit(fileContents: string): TestResult[] {
  // Validate FIRST: `XMLParser.parse` is lenient and silently accepts a lot of
  // malformed input (unclosed/mismatched tags), which would let a corrupted
  // results file read as "parsed fine, 0 tests" — a false STABLE result. SPEC §6
  // requires an unparseable results file to be treated as a crashed run, so we
  // gate on `XMLValidator` (which reports well-formedness errors the parser won't).
  const validation = XMLValidator.validate(fileContents);
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw new Error(`Invalid JUnit XML: ${msg} (line ${line}, col ${col})`);
  }

  let doc: unknown;
  try {
    doc = parser.parse(fileContents);
  } catch (err) {
    // Belt-and-braces: anything the validator missed but the parser rejects is
    // still an unparseable results file (SPEC §6) — surface a clear reason.
    throw new Error(`Invalid JUnit XML: ${(err as Error).message}`);
  }

  const results: TestResult[] = [];
  for (const suite of collectSuites(doc)) {
    // A suite's `name` is the file for Vitest/Jest; used as a fallback when a
    // testcase omits `classname`.
    const suiteFile = attr(suite, "name");
    for (const testcase of asArray(suite.testcase as JunitNode | JunitNode[] | undefined)) {
      const name = attr(testcase, "name") ?? "(unnamed test)";
      const file = attr(testcase, "classname") ?? suiteFile ?? "(unknown file)";
      const status = statusOf(testcase);
      const durationMs = durationOf(testcase);
      const result: TestResult = { id: buildId(file, undefined, name), file, name, status };
      if (durationMs !== undefined) result.durationMs = durationMs;
      results.push(result);
    }
  }
  return results;
}

/** Extract the list of `<testsuite>` nodes from either accepted root shape. */
function collectSuites(doc: unknown): JunitNode[] {
  const root = doc as Record<string, unknown> | undefined;
  // `<testsuites>` wrapper (many suites).
  const suites = (root?.testsuites as JunitNode | undefined)?.testsuite as
    | JunitNode
    | JunitNode[]
    | undefined;
  if (suites) return asArray(suites);
  // Single top-level `<testsuite>` (pytest-style). `isArray` already made it an
  // array; the cast keeps TS happy.
  if (root?.testsuite) return asArray(root.testsuite as JunitNode | JunitNode[]);
  return [];
}

function statusOf(testcase: JunitNode): Status {
  // `<skipped/>` self-closes to "" and `<failure>` to an object — both are
  // merely "present", so an existence check is all we need.
  if (testcase.skipped !== undefined) return "skip";
  if (testcase.failure !== undefined || testcase.error !== undefined) return "fail";
  return "pass";
}

function durationOf(testcase: JunitNode): number | undefined {
  const raw = attr(testcase, "time");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

/** Loosely-typed parsed XML node (attributes are prefixed keys). */
type JunitNode = Record<string, unknown>;

/** Read an attribute as a string, treating missing/null as absent. */
function attr(node: JunitNode | undefined, key: string): string | undefined {
  const value = node?.[`${ATTR_PREFIX}${key}`];
  return value === undefined || value === null ? undefined : String(value);
}

/** Normalize "possibly missing / possibly single / possibly array" to array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export const junitParser: ResultParser = {
  name: "junit",
  parse: parseJunit,
};
