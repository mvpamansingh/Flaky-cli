import { beforeEach, describe, expect, it } from "vitest";
import {
  SIGINT_EXIT_CODE,
  onInterrupt,
  resetInterruptCleanups,
  runInterruptCleanups,
} from "../src/utils/interrupt.js";

/**
 * The Ctrl-C cleanup registry (Phase 9).
 *
 * We test the registry, never `installInterruptHandler` — that one calls
 * `process.exit`, which would take the test runner down with it. The registry is where
 * the logic actually lives, and it's pure, which is the point of the inversion: `core`
 * and `commands` register into a leaf instead of a leaf reaching up to kill processes.
 */
beforeEach(() => {
  resetInterruptCleanups();
});

describe("onInterrupt / runInterruptCleanups", () => {
  it("runs every registered cleanup", () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push("spinner"));
    onInterrupt(() => ran.push("kill-tree"));
    runInterruptCleanups();
    expect(ran).toHaveLength(2);
  });

  it("runs most-recently-registered first (visible chrome before slow kills)", () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push("first"));
    onInterrupt(() => ran.push("second"));
    runInterruptCleanups();
    expect(ran).toEqual(["second", "first"]);
  });

  it("isolates a throwing cleanup so the others still run", () => {
    const ran: string[] = [];
    onInterrupt(() => ran.push("survivor"));
    onInterrupt(() => {
      throw new Error("cleanup blew up");
    });
    const failures = runInterruptCleanups();
    // The point: killing the child tree must not be skipped because the spinner
    // threw while being torn down. There is no recovery path during an abort.
    expect(failures).toBe(1);
    expect(ran).toEqual(["survivor"]);
  });

  it("unregisters via the returned function", () => {
    const ran: string[] = [];
    const off = onInterrupt(() => ran.push("stale"));
    off();
    runInterruptCleanups();
    expect(ran).toEqual([]);
  });

  it("drains the registry, so a second abort is a no-op", () => {
    let count = 0;
    onInterrupt(() => count++);
    runInterruptCleanups();
    runInterruptCleanups();
    expect(count).toBe(1);
  });

  it("deduplicates by identity (module-load registration is safe to repeat)", () => {
    let count = 0;
    const cleanup = () => count++;
    onInterrupt(cleanup);
    onInterrupt(cleanup);
    runInterruptCleanups();
    expect(count).toBe(1);
  });

  it("uses the POSIX 128 + SIGINT exit code", () => {
    expect(SIGINT_EXIT_CODE).toBe(130);
  });
});
