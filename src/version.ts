/**
 * The tool's version — a leaf constant so the CLI banner and the machine-readable
 * exports can never drift apart.
 *
 * Deliberately a hardcoded constant rather than a runtime read of `package.json`:
 * the built `dist/cli.js` sits one directory below the manifest, so resolving it at
 * runtime would mean fragile path math (and an fs read) for a value that is fixed at
 * build time. Bump this together with `package.json`'s `version` when releasing.
 */
export const TOOL_NAME = "flaky-detective";
export const TOOL_VERSION = "0.0.0";
