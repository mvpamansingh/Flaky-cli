import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_NAME } from "../version.js";

/**
 * Unique temp results paths, one per run.
 *
 * Rule #4: never rely on a single overwritten path. Each run writes to its own
 * freshly-named file so a crashed run can never be read as a previous run's
 * stale success. Files live under the OS temp dir in a namespace named after the
 * tool so they're easy to find and safe to leave for the OS to reap.
 *
 * Leaf module: the only thing it imports from `src/` is the `TOOL_NAME` constant
 * (itself a leaf), so the temp namespace can't drift from the published name.
 */

/** Directory (under the OS temp dir) that holds all of our per-run results. */
export const RESULTS_DIR = join(tmpdir(), TOOL_NAME);

/**
 * Create (if needed) and return a unique absolute path for one run's results.
 * @param runIndex 1-based run number, zero-padded into the name for readability.
 */
export async function uniqueResultsPath(runIndex: number, ext = "xml"): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const name = `run-${String(runIndex).padStart(3, "0")}-${randomUUID()}.${ext}`;
  return join(RESULTS_DIR, name);
}

/**
 * Normalize a path to forward slashes.
 *
 * We inject temp paths into the user's test command; forward slashes are safe on
 * every platform (Node and test-runner CLIs accept them on Windows too), whereas
 * backslashes get mangled by shells and by dot-notation flag parsers like
 * `--outputFile.junit=`.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
