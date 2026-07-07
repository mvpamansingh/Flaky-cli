import { defineConfig } from 'vitest/config';

// Emit BOTH a human-readable default report (stdout) and a machine-readable
// JUnit XML file at a known path. Flaky-test Detective reads the XML; the
// default reporter is just so a human running `npm test` sees something nice.
//
// NOTE: JUnit XML is written regardless of whether tests pass or fail — a
// non-zero exit code from a failing run still produces a valid results file.
// That is exactly the contract our CLI relies on (CLAUDE.md rule #2).
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './reports/junit.xml',
    },
  },
});