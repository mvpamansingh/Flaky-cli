/**
 * Timing helpers — humanize durations for progress lines, the first-run sweep
 * estimate (SPEC §6), and later the report.
 *
 * Leaf module: imports nothing else in `src/`.
 */

/**
 * Format a millisecond duration as a short, human-readable string:
 * `"820ms"`, `"2.4s"`, `"3m 05s"`. Rounds; never shows sub-second noise past ~1s.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
