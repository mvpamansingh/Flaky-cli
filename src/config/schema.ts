import { z } from "zod";

/**
 * The `flaky.config.json` schema — the single source of truth for what a valid
 * config looks like. The config *is* the language-agnostic mechanism: the user
 * tells us their test command once instead of us hardcoding frameworks.
 *
 * Defaults here mirror the flags on `flaky run` (see SPEC §3) so that a sparse
 * config and a bare invocation behave identically.
 */
export const configSchema = z
  .object({
    // The existing test command to shell out to, e.g. "npm test", "pytest".
    command: z.string().trim().min(1, 'must be a non-empty test command, e.g. "npm test"'),

    // Which parser to feed the results file through.
    reporter: z.enum(["junit", "json"]).default("junit"),

    // Where the runner writes its machine-readable results each run.
    resultsPath: z
      .string()
      .trim()
      .min(1, 'must point at the file your runner writes, e.g. "./reports/junit.xml"'),

    // Default N — how many full-suite runs make up a sweep.
    times: z.int().min(1, "needs at least 1 run").default(20),

    // Per-run timeout so one hung run can't freeze the whole sweep.
    timeoutMs: z.int().min(1, "must be a positive number of milliseconds").default(300_000),

    // Isolation diagnosis: off by default.
    isolate: z.boolean().default(false),

    // R — times to re-run each flaky test alone during isolation.
    isolationRuns: z.int().min(1, "needs at least 1 isolation run").default(10),

    // Optional template to run ONE test alone. Framework-specific filter syntax
    // lives here, keeping our tool agnostic. Placeholders: {file} {testName}.
    isolateCommand: z.string().trim().min(1).optional(),
  })
  // Reject unknown keys so typos (e.g. "reporters") surface instead of silently
  // doing nothing.
  .strict();

/** The validated, defaults-applied config the rest of the tool consumes. */
export type Config = z.infer<typeof configSchema>;

/** The raw, pre-validation shape (what `flaky init` assembles before writing). */
export type ConfigInput = z.input<typeof configSchema>;
