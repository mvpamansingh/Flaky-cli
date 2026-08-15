/**
 * Table-driven tests for the Phase 4 parser (`junitParser.parse`, A-series) and the
 * reporter registry (`getParser`, B-series).
 *
 * Started life as a manual eyeball harness that printed ACTUAL vs EXPECTED for every
 * vector; Phase 9 dropped the printing (vitest already shows a diff on failure, and
 * the logs drowned out the rest of `npm test`) and renamed the file from
 * `junit.manual.test.ts`, since the assertions had long since made it automatic.
 * The vector table is the valuable part and is unchanged.
 *
 * Run just this file: `npx vitest run tests/junit.test.ts`
 */
import { describe, expect, it } from "vitest";
import { getParser } from "../src/parsers/index.js";
import { junitParser } from "../src/parsers/junit.js";
import type { TestResult } from "../src/types.js";

// --- A-series: junitParser.parse(xml) -> TestResult[] ------------------------

interface Vector {
  id: string; // A1, A2, ...
  what: string; // what it verifies
  xml: string;
  expected: TestResult[];
}

const A: Vector[] = [
  {
    id: "A1",
    what: "<testsuites> wrapper, multi-suite, mixed pass/fail, seconds->ms",
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="3" failures="1">
  <testsuite name="tests/random.test.ts" tests="2" failures="1">
    <testcase classname="tests/random.test.ts" name="random passes" time="0.012"/>
    <testcase classname="tests/random.test.ts" name="random flakes" time="0.005">
      <failure message="expected true to be false">AssertionError</failure>
    </testcase>
  </testsuite>
  <testsuite name="tests/time.test.ts" tests="1" failures="0">
    <testcase classname="tests/time.test.ts" name="time check" time="1.5"/>
  </testsuite>
</testsuites>`,
    expected: [
      {
        id: "tests/random.test.ts :: random passes",
        file: "tests/random.test.ts",
        name: "random passes",
        status: "pass",
        durationMs: 12,
      },
      {
        id: "tests/random.test.ts :: random flakes",
        file: "tests/random.test.ts",
        name: "random flakes",
        status: "fail",
        durationMs: 5,
      },
      {
        id: "tests/time.test.ts :: time check",
        file: "tests/time.test.ts",
        name: "time check",
        status: "pass",
        durationMs: 1500,
      },
    ],
  },
  {
    id: "A2",
    what: "single top-level <testsuite> (pytest-style, no wrapper)",
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="pytest" tests="2" failures="1">
  <testcase classname="test_math.py" name="test_add" time="0.001"/>
  <testcase classname="test_math.py" name="test_divide" time="0.002">
    <failure message="ZeroDivisionError">boom</failure>
  </testcase>
</testsuite>`,
    expected: [
      {
        id: "test_math.py :: test_add",
        file: "test_math.py",
        name: "test_add",
        status: "pass",
        durationMs: 1,
      },
      {
        id: "test_math.py :: test_divide",
        file: "test_math.py",
        name: "test_divide",
        status: "fail",
        durationMs: 2,
      },
    ],
  },
  {
    id: "A3",
    what: "singleton collapse guard (one suite, one case) -> isArray config",
    xml: `<testsuites>
  <testsuite name="solo.test.ts">
    <testcase classname="solo.test.ts" name="only test" time="0.1"/>
  </testsuite>
</testsuites>`,
    expected: [
      {
        id: "solo.test.ts :: only test",
        file: "solo.test.ts",
        name: "only test",
        status: "pass",
        durationMs: 100,
      },
    ],
  },
  {
    id: "A4",
    what: "<skipped> -> skip; time=0 keeps durationMs:0",
    xml: `<testsuite name="skip.test.ts">
  <testcase classname="skip.test.ts" name="skipped one" time="0"><skipped/></testcase>
</testsuite>`,
    expected: [
      {
        id: "skip.test.ts :: skipped one",
        file: "skip.test.ts",
        name: "skipped one",
        status: "skip",
        durationMs: 0,
      },
    ],
  },
  {
    id: "A5",
    what: "<error> maps to fail (same as <failure>)",
    xml: `<testsuite name="err.test.ts">
  <testcase classname="err.test.ts" name="throws" time="0.02"><error message="TypeError">stack</error></testcase>
</testsuite>`,
    expected: [
      {
        id: "err.test.ts :: throws",
        file: "err.test.ts",
        name: "throws",
        status: "fail",
        durationMs: 20,
      },
    ],
  },
  {
    id: "A6",
    what: "no time attribute -> durationMs key OMITTED",
    xml: `<testsuite name="notime.test.ts">
  <testcase classname="notime.test.ts" name="no timing"/>
</testsuite>`,
    expected: [
      {
        id: "notime.test.ts :: no timing",
        file: "notime.test.ts",
        name: "no timing",
        status: "pass",
      },
    ],
  },
  {
    id: "A7",
    what: "missing classname -> falls back to suite name",
    xml: `<testsuite name="fallback.test.ts">
  <testcase name="no classname" time="0.003"/>
</testsuite>`,
    expected: [
      {
        id: "fallback.test.ts :: no classname",
        file: "fallback.test.ts",
        name: "no classname",
        status: "pass",
        durationMs: 3,
      },
    ],
  },
  {
    id: "A8",
    what: 'numeric-looking name "0.30" NOT coerced (parseAttributeValue:false)',
    xml: `<testsuite name="numeric.test.ts">
  <testcase classname="numeric.test.ts" name="0.30" time="0.01"/>
</testsuite>`,
    expected: [
      {
        id: "numeric.test.ts :: 0.30",
        file: "numeric.test.ts",
        name: "0.30",
        status: "pass",
        durationMs: 10,
      },
    ],
  },
  {
    id: "A9",
    what: "unnamed testcase / unknown file placeholders",
    xml: `<testsuites>
  <testsuite>
    <testcase time="0.001"/>
  </testsuite>
</testsuites>`,
    expected: [
      {
        id: "(unknown file) :: (unnamed test)",
        file: "(unknown file)",
        name: "(unnamed test)",
        status: "pass",
        durationMs: 1,
      },
    ],
  },
  {
    id: "A10",
    what: "non-finite time -> durationMs OMITTED",
    xml: `<testsuite name="badtime.test.ts">
  <testcase classname="badtime.test.ts" name="nan time" time="abc"/>
</testsuite>`,
    expected: [
      {
        id: "badtime.test.ts :: nan time",
        file: "badtime.test.ts",
        name: "nan time",
        status: "pass",
      },
    ],
  },
  {
    id: "A11",
    what: "empty <testsuites> -> [] (valid, not a throw)",
    xml: "<testsuites></testsuites>",
    expected: [],
  },
  {
    id: "A12",
    what: "suite with zero testcases -> []",
    xml: `<testsuite name="empty.test.ts" tests="0"></testsuite>`,
    expected: [],
  },
];

describe("A-series: junitParser.parse", () => {
  for (const v of A) {
    it(`${v.id} — ${v.what}`, () => {
      expect(junitParser.parse(v.xml)).toEqual(v.expected);
    });
  }

  it("A13 — malformed XML throws 'Invalid JUnit XML: ...'", () => {
    // Load-bearing (rule #2): fast-xml-parser's `parse` is lenient and would return
    // an object for this, which the sweep would read as "parsed fine, 0 tests" — a
    // false `stable` verdict on a corrupted file. The validator makes it a crash.
    const bad = '<testsuites><testsuite name="x"></testsuites>';
    expect(() => junitParser.parse(bad)).toThrow(/^Invalid JUnit XML:/);
  });
});

// --- B-series: getParser(name) ----------------------------------------------

describe("B-series: getParser", () => {
  it("B1 — getParser('junit') returns the junit parser", () => {
    expect(getParser("junit").name).toBe("junit");
  });

  it("B2 — getParser('json') throws actionable error", () => {
    // `json` passes the config schema but has no adapter yet, so this must fail
    // early (run.ts resolves the parser BEFORE sweeping) with a message that says
    // what IS supported.
    expect(() => getParser("json")).toThrow(
      'No parser available for reporter "json". Supported reporters: junit.',
    );
  });

  it("B3 — getParser('mocha') throws actionable error", () => {
    expect(() => getParser("mocha")).toThrow(
      'No parser available for reporter "mocha". Supported reporters: junit.',
    );
  });
});
