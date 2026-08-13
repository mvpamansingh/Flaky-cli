import { configDefaults, defineConfig } from "vitest/config";

/**
 * Vitest config for OUR tool's own tests — the fast, pure suite (`npm test`).
 *
 * Collect ONLY from the root `tests/` directory. The `fixtures/sample-project`
 * suite is DELIBERATELY broken (its tests flake / fail on purpose so we have
 * something to detect) and is a self-contained sub-project with its own Vitest —
 * it must never be collected by our suite (Decisions log: fixture stays isolated).
 *
 * `*.live.test.ts` files are excluded here and run from `vitest.live.config.ts`
 * via `npm run test:live`. They spawn REAL fixture test runs (seconds each), so
 * keeping them out of the default suite keeps `npm test` fast, hermetic and
 * deterministic — and lets the live suite enforce rule #1 on its own terms.
 * (Spread `configDefaults.exclude` so overriding `exclude` doesn't drop Vitest's
 * own node_modules/dist ignores.)
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/**/*.live.test.ts"],
  },
});
