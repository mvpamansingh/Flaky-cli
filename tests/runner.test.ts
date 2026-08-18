import { describe, expect, it } from "vitest";
import { type ProcessLink, descendantClosure } from "../src/core/runner.js";

/**
 * `descendantClosure` is the pure half of the Windows tree-kill.
 *
 * It exists because `taskkill /T` can't do the job: `/T` walks the LIVE parent→child
 * chain, and on Ctrl-C Windows kills the spawned `cmd.exe` — the only pid we hold —
 * before our handler runs. With the middle link gone, taskkill finds nothing and the
 * real test process is orphaned. The recorded ParentProcessId survives that death,
 * so we walk the links ourselves. These cases pin that behaviour without spawning
 * anything.
 */

/** The shape our sweep actually produces: CLI → cmd.exe → npm → vitest → workers. */
const REAL_SWEEP: ProcessLink[] = [
  { pid: 2000, parentPid: 1000 }, // cmd.exe      ← the pid we hold
  { pid: 3000, parentPid: 2000 }, // npm
  { pid: 4000, parentPid: 3000 }, // vitest
  { pid: 5000, parentPid: 4000 }, // worker
  { pid: 5001, parentPid: 4000 }, // worker
  { pid: 9999, parentPid: 8888 }, // somebody else's process entirely
];

describe("descendantClosure", () => {
  it("returns the root alone when nothing descends from it", () => {
    expect(descendantClosure(2000, [{ pid: 9999, parentPid: 8888 }])).toEqual([2000]);
  });

  it("collects the whole spawn chain, not just the direct child", () => {
    const killed = descendantClosure(2000, REAL_SWEEP);
    expect(killed).toContain(2000); // the shell
    expect(killed).toContain(3000); // npm
    expect(killed).toContain(4000); // vitest
    expect(killed).toContain(5000); // its workers
    expect(killed).toContain(5001);
  });

  it("leaves unrelated processes alone", () => {
    // The whole reason we kill by pid and never by image name: half the tree is
    // node.exe, and so is the user's editor.
    expect(descendantClosure(2000, REAL_SWEEP)).not.toContain(9999);
  });

  it("kills leaves before their parents", () => {
    const killed = descendantClosure(2000, REAL_SWEEP);
    expect(killed.indexOf(5000)).toBeLessThan(killed.indexOf(4000));
    expect(killed.indexOf(4000)).toBeLessThan(killed.indexOf(3000));
    expect(killed.indexOf(3000)).toBeLessThan(killed.indexOf(2000));
    expect(killed.at(-1)).toBe(2000); // the root goes last
  });

  it("THE BUG: still finds descendants when the parent is already dead", () => {
    // Ctrl-C kills cmd.exe (2000) first, so it no longer appears in the table at
    // all — but npm still records it as its parent. taskkill /T gives up here;
    // we must not. This is the case that let a test suite run on after an abort.
    const parentAlreadyGone = REAL_SWEEP.filter((link) => link.pid !== 2000);
    const killed = descendantClosure(2000, parentAlreadyGone);
    expect(killed).toContain(3000);
    expect(killed).toContain(4000);
    expect(killed).toContain(5000);
  });

  it("survives a corrupt table with a parent cycle", () => {
    const cyclic: ProcessLink[] = [
      { pid: 2000, parentPid: 3000 },
      { pid: 3000, parentPid: 2000 },
    ];
    expect(() => descendantClosure(2000, cyclic)).not.toThrow();
    expect(descendantClosure(2000, cyclic)).toEqual([3000, 2000]);
  });

  it("reports each pid once even when it appears twice", () => {
    const duplicated = [...REAL_SWEEP, { pid: 3000, parentPid: 2000 }];
    const killed = descendantClosure(2000, duplicated);
    expect(killed.filter((pid) => pid === 3000)).toHaveLength(1);
  });
});
