import { defineConfig } from "vitest/config";

/**
 * Vitest config for OUR tool's own tests.
 *
 * Collect ONLY from the root `tests/` directory. The `fixtures/sample-project`
 * suite is DELIBERATELY broken (its tests flake / fail on purpose so we have
 * something to detect) and is a self-contained sub-project with its own Vitest —
 * it must never be collected by our suite (Decisions log: fixture stays isolated).
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
