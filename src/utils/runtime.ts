/**
 * Runtime environment guard (Phase 9).
 *
 * `package.json`'s `engines` field is advisory: npm warns at install time, and `npx`
 * runs the tool anyway. So on an unsupported Node the user's first experience is a
 * syntax or "not a function" error from deep inside a dependency — which reads like
 * OUR bug. One explicit check up front turns that into a sentence they can act on.
 *
 * Node 20 is the floor because the project is ESM-only (`execa` latest is ESM-only,
 * see the tech-stack lock in CLAUDE.md) and 18 is end-of-life.
 *
 * The comparison is a pure function taking the version string so it can be tested
 * against versions this machine isn't running.
 */

export const MIN_NODE_MAJOR = 20;

/**
 * Returns an actionable error message when `version` is too old, else `undefined`.
 *
 * Accepts the `v20.11.0` form `process.version` uses and the bare `20.11.0` form.
 * An unparseable version returns `undefined` — refusing to run because we couldn't
 * read the version would be worse than trying and possibly working.
 */
export function nodeVersionError(version: string, min = MIN_NODE_MAJOR): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, ""), 10);
  if (!Number.isFinite(major)) return undefined;
  if (major >= min) return undefined;
  return `✗ flaky needs Node ${min} or newer (this is Node ${version}). Upgrade Node, or run it under a newer runtime — the tool is ESM-only and cannot work on ${major}.x.`;
}
