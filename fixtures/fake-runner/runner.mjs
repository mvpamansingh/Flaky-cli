#!/usr/bin/env node
/**
 * A DETERMINISTIC fake test runner, for CLI integration tests (Phase 9).
 *
 * Why this exists
 * ---------------
 * `fixtures/sample-project` is a real Vitest suite whose flakes are genuinely
 * probabilistic (coin flip, wall clock). That is exactly right for proving the tool
 * works against a real runner — and exactly wrong for asserting exact numbers: the
 * Phase 7 test plan has to say "use -n 15 or the flakes may not flip", which means a
 * CLI test built on it would be a FLAKY TEST INSIDE A FLAKE DETECTOR.
 *
 * So this runner fakes the only thing our tool actually requires of a test runner:
 * write a JUnit XML file and exit. It is not a test framework, which is itself a nice
 * proof of the framework-agnostic claim — our CLI cannot tell the difference.
 *
 * Determinism comes from a counter persisted in `--state`: run 1, 2, 3… produce a
 * fixed pattern, so a 4-run sweep has exactly one possible report.
 *
 * The specimens (suite mode)
 * --------------------------
 *   alpha stable    always passes                     → stable-pass
 *   bravo coin      fails on EVEN runs                → flaky (50% at N=4)
 *   charlie order   fails on EVEN runs                → flaky (50% at N=4)
 *   delta broken    always fails                      → consistently-failing
 *   echo skipped    always skipped                    → skips stay out of the denominator
 *
 * Alone mode (`--only <name>`, what `isolateCommand` invokes)
 * ----------------------------------------------------------
 *   bravo coin      still FAILS alone   → internally-nondeterministic
 *   charlie order   PASSES alone        → order-dependent
 *
 * That second row is the point: it makes the order-dependent branch reachable through
 * the real CLI, which the Phase 7 docs recorded as impossible against the Vitest
 * fixture (its order-victim fails 100% in-suite, so it classifies as
 * consistently-failing and is never isolated).
 *
 * Alone mode also emits the OTHER tests as `<skipped/>`, mirroring what Vitest really
 * writes — that exercises isolate.ts's "match on file+name, ignore skips" path.
 *
 * Failure modes for negative-path tests: `--no-results`, `--garbage`, `--sleep <ms>`,
 * `--crash-on <n>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { argv, exit } from "node:process";

const FILE = "fake/suite.spec.js";

function arg(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const has = (name) => argv.includes(`--${name}`);

const out = arg("out");
const statePath = arg("state");
const only = arg("only");
const sleepMs = Number(arg("sleep", "0"));
const crashOn = Number(arg("crash-on", "0"));

if (!out) {
  console.error("fake-runner: --out <path> is required");
  exit(2);
}

// --- Run counter ------------------------------------------------------------
// Persisted next to nothing in particular; the caller owns the path so each test
// case gets a private, fresh counter.
let count = 1;
if (statePath) {
  try {
    count = JSON.parse(readFileSync(statePath, "utf8")).count + 1;
  } catch {
    count = 1; // first run of this case
  }
  writeFileSync(statePath, JSON.stringify({ count }));
}

// --- Negative paths ---------------------------------------------------------

if (sleepMs > 0) {
  // Busy-block, deliberately ignoring signals, so rule #3's tree-kill is what ends
  // this process rather than a cooperative exit.
  const until = Date.now() + sleepMs;
  while (Date.now() < until) {
    /* spin */
  }
}

if (has("no-results") || crashOn === count) {
  // Exit non-zero WITHOUT writing results: the runner itself blew up (rule #2's
  // "real error" side, as opposed to tests merely failing).
  console.error(`fake-runner: simulated runner failure on run ${count}`);
  exit(1);
}

if (has("garbage")) {
  // Well-formed-looking but invalid XML: the parser must reject it and the run must
  // be counted as crashed, not as "parsed fine, 0 tests" (see the Phase 4 fix).
  writeFileSync(out, "<testsuites><testsuite name=oops></testsuites>");
  exit(1);
}

// --- Normal results ---------------------------------------------------------

const failsThisRun = count % 2 === 0;

/** @type {Array<{name: string, status: "pass"|"fail"|"skip"}>} */
let cases;
if (only) {
  cases = [
    { name: "alpha stable", status: "skip" },
    { name: "bravo coin", status: "skip" },
    { name: "charlie order", status: "skip" },
    { name: "delta broken", status: "skip" },
    { name: "echo skipped", status: "skip" },
  ].map((c) =>
    c.name !== only
      ? c
      : // Alone: bravo still fails (internal cause), charlie passes (needed the others).
        { name: c.name, status: c.name === "bravo coin" ? "fail" : "pass" },
  );
} else {
  cases = [
    { name: "alpha stable", status: "pass" },
    { name: "bravo coin", status: failsThisRun ? "fail" : "pass" },
    { name: "charlie order", status: failsThisRun ? "fail" : "pass" },
    { name: "delta broken", status: "fail" },
    { name: "echo skipped", status: "skip" },
  ];
}

const body = cases
  .map(({ name, status }) => {
    const open = `    <testcase classname="${FILE}" name="${name}" time="0.001"`;
    if (status === "pass") return `${open}/>`;
    if (status === "skip") return `${open}><skipped/></testcase>`;
    return `${open}>\n      <failure message="simulated failure on run ${count}">AssertionError</failure>\n    </testcase>`;
  })
  .join("\n");

const failures = cases.filter((c) => c.status === "fail").length;
writeFileSync(
  out,
  `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="fake-runner" tests="${cases.length}" failures="${failures}">
  <testsuite name="${FILE}" tests="${cases.length}" failures="${failures}">
${body}
  </testsuite>
</testsuites>
`,
);

// Rule #2: failing tests make a real runner exit non-zero, and our CLI must treat
// that as data. Exit 1 whenever anything failed, so the tests exercise that path.
exit(failures > 0 ? 1 : 0);
