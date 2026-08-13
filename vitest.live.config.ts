import { defineConfig } from "vitest/config";

/**
 * Vitest config for the LIVE suite — `npm run test:live`.
 *
 * Live tests exercise the I/O half of the engine (`core/runner.ts`,
 * `core/sweep.ts`, `core/isolate.ts`) by spawning REAL test runs against
 * `fixtures/sample-project`. That's the only way to cover what mocking can't:
 * regex + shell escaping surviving execa → `cmd.exe`, crash detection, tree-kill.
 *
 * **`fileParallelism: false` is load-bearing (CLAUDE.md rule #1).** Every live
 * case spawns a real fixture suite run; two files doing that concurrently would
 * contend for the fixture's `reports/` dir and Vite cache and MANUFACTURE the
 * exact flakiness this tool exists to detect — false failures in the flake
 * detector's own suite. Rule #1 governs the product's sweep loop, but its reason
 * applies here verbatim, so the live suite runs one file at a time in one
 * process. (Tests *within* a file are already sequential unless marked
 * `.concurrent`, which live tests must never be.)
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.live.test.ts"],
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
  },
});
