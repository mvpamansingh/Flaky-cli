import { describe, expect, it } from "vitest";
import { resolveIsolate } from "../src/commands/run.js";

/**
 * Pure resolution helpers from `commands/run.ts`.
 *
 * `resolveIsolate` is the Phase 9 escape hatch (`--no-isolate`). The interesting
 * case is `undefined`: commander only produces it when `cli.ts` declares `--isolate`
 * BEFORE `--no-isolate` (verified empirically against commander 13 — declaring the
 * negation first defaults the option to `true`). If that ordering ever regresses,
 * `opts.isolate` arrives as `true`, the config value stops being consulted, and every
 * sweep silently runs an isolation pass. These three cases pin the contract that
 * ordering exists to protect.
 */
describe("resolveIsolate — tri-state isolation switch", () => {
  it("--isolate wins over a config that disables isolation", () => {
    expect(resolveIsolate(true, false)).toBe(true);
  });

  it("--no-isolate wins over a config that enables isolation (the escape hatch)", () => {
    expect(resolveIsolate(false, true)).toBe(false);
  });

  it("neither flag defers to the config — both ways", () => {
    expect(resolveIsolate(undefined, true)).toBe(true);
    expect(resolveIsolate(undefined, false)).toBe(false);
  });

  it("uses ?? not || — an explicit false is not treated as absent", () => {
    // The bug this guards: `opts.isolate || config.isolate` would return `true` here,
    // making `--no-isolate` a no-op against `"isolate": true`.
    expect(resolveIsolate(false, true)).not.toBe(true);
  });
});
