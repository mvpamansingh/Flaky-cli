/**
 * TTY / color gating — the single source of truth for CLAUDE.md rule #5
 * ("Detect TTY. No colors/spinners when piped or in `--json` mode.").
 *
 * A leaf util: imports nothing else in `src`. Two output streams are gated
 * independently because they carry different things (SPEC §5 output split):
 *   - the report goes to **stdout** → its colors depend on `process.stdout`
 *   - progress/spinner goes to **stderr** → depends on `process.stderr`
 * so callers pass the stream they're about to write to.
 */

/**
 * True when it's safe to emit ANSI colors / spinners to `stream`.
 *
 * Requires the stream to be an interactive TTY AND honors the `NO_COLOR`
 * convention (https://no-color.org) — any non-empty `NO_COLOR` forces plain
 * output even in a terminal, which keeps piped/redirected and opted-out output
 * clean.
 */
export function isInteractive(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(stream.isTTY);
}
