/**
 * The tool's version — a leaf constant so the CLI banner and the machine-readable
 * exports can never drift apart.
 *
 * Deliberately a hardcoded constant rather than a runtime read of `package.json`:
 * the built `dist/cli.js` sits one directory below the manifest, so resolving it at
 * runtime would mean fragile path math (and an fs read) for a value that is fixed at
 * build time. Bump this together with `package.json`'s `version` when releasing.
 *
 * `TOOL_NAME` is the npm package name, not the `bin` name: reports are read elsewhere,
 * where "how do I install this?" is the useful identity. The command stays `flaky`.
 * (Published as `flaky-test-detective` because `flaky-detective` was already taken on
 * npm by an unrelated package — checked in Phase 9.)
 */
export const TOOL_NAME = "flaky-test-detective";
export const TOOL_VERSION = "0.1.0";
