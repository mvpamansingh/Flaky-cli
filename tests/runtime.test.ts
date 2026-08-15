import { describe, expect, it } from "vitest";
import { MIN_NODE_MAJOR, nodeVersionError } from "../src/utils/runtime.js";

/**
 * The Node engine guard (Phase 9). Pure by design so it can be tested against
 * versions this machine isn't running — the whole point is the *unsupported* path,
 * which is otherwise unreachable in CI.
 */
describe("nodeVersionError", () => {
  it("accepts the supported floor and anything above it", () => {
    expect(nodeVersionError("v20.0.0")).toBeUndefined();
    expect(nodeVersionError("v22.11.0")).toBeUndefined();
    expect(nodeVersionError("v24.15.0")).toBeUndefined();
  });

  it("rejects older majors with an actionable message", () => {
    const msg = nodeVersionError("v18.19.0");
    expect(msg).toBeDefined();
    expect(msg).toContain("needs Node 20 or newer");
    expect(msg).toContain("v18.19.0"); // tells them what they're actually on
  });

  it("accepts a bare version string too (no leading v)", () => {
    expect(nodeVersionError("20.11.0")).toBeUndefined();
    expect(nodeVersionError("16.20.2")).toBeDefined();
  });

  it("stays out of the way when the version is unparseable", () => {
    // Refusing to run because we couldn't READ the version would be worse than
    // trying and possibly working.
    expect(nodeVersionError("weird-custom-build")).toBeUndefined();
    expect(nodeVersionError("")).toBeUndefined();
  });

  it("honors an explicit minimum", () => {
    expect(nodeVersionError("v20.0.0", 22)).toBeDefined();
    expect(nodeVersionError("v22.0.0", 22)).toBeUndefined();
  });

  it("keeps the documented floor at 20 (ESM-only stack, 18 is EOL)", () => {
    expect(MIN_NODE_MAJOR).toBe(20);
  });
});
