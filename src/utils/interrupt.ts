/**
 * Cooperative Ctrl-C handling (Phase 9).
 *
 * Why this exists: the large-sweep warning literally tells the user "Press Ctrl-C to
 * abort", so aborting has to behave. Two things go wrong if we let the default happen:
 *
 *  1. **Orphaned test runs.** `core/runner.ts` spawns the user's command `detached` on
 *     POSIX (its own process group) so rule #3's timeout can tree-kill it. That same
 *     detachment means a terminal's Ctrl-C does NOT reach the child: our process dies
 *     and their whole test suite keeps running, holding the ports/DBs/files that the
 *     Decisions log already identified as manufactured flakiness for later runs.
 *  2. **A wrecked terminal.** `ora` hides the cursor while spinning; dying mid-frame
 *     can leave a hidden cursor and a half-drawn spinner line behind.
 *
 * Shape: this module is a **leaf** (SPEC §11 — `utils` imports nothing upward), so it
 * can't reach into `core` to kill anything or into `commands` to stop a spinner.
 * Instead it owns a registry and those layers register *into* it — an inversion that
 * keeps the dependency graph acyclic and makes the ordering logic testable without
 * spawning a process or installing a real signal handler.
 */

/** A cleanup callback. Must be synchronous — we are on our way out. */
export type InterruptCleanup = () => void;

const cleanups = new Set<InterruptCleanup>();

let aborting = false;

/**
 * True once an abort has begun.
 *
 * Exposed because a child dying is not the same event as a run *finishing*: when the
 * user hits Ctrl-C, the OS may kill the spawned shell, which settles the subprocess
 * promise and would normally make `core/runner.ts` deregister that pid as "done" — in
 * a race against the cleanup that still needs it to find the tree. Reading this flag
 * lets the run loop keep the pid while we are on our way out.
 */
export function isAborting(): boolean {
  return aborting;
}

/** Test seam: clear the abort flag between cases. */
export function resetAborting(): void {
  aborting = false;
}

/**
 * Register work to do if the user aborts. Returns an unregister function; callers
 * that finish normally should call it so a completed sweep leaves nothing behind.
 */
export function onInterrupt(cleanup: InterruptCleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/**
 * Run every registered cleanup, most-recently-registered FIRST.
 *
 * Reverse order because registration follows the layering — the spinner is started
 * around the sweep that spawns the children — and on the way out we want the visible
 * chrome torn down before the slower process-killing work. A throwing cleanup must
 * never prevent the others from running (we are aborting; there is no recovery path),
 * so each is isolated. Returns the number that threw, for tests.
 */
export function runInterruptCleanups(): number {
  let failures = 0;
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch {
      failures++;
    }
  }
  cleanups.clear();
  return failures;
}

/** Test seam: forget every registration without running it. */
export function resetInterruptCleanups(): void {
  cleanups.clear();
}

/** 128 + SIGINT(2) — the POSIX convention for "killed by Ctrl-C". */
export const SIGINT_EXIT_CODE = 130;

let installed = false;

/**
 * Install the process-level SIGINT/SIGTERM handler. Idempotent.
 *
 * We exit as soon as the cleanups have run rather than waiting for the child tree to
 * confirm it died: the kill signal has already been delivered, and a user who just hit
 * Ctrl-C should get their prompt back immediately. A second Ctrl-C bypasses everything
 * — if cleanup itself is what's hanging, the user still gets out.
 */
export function installInterruptHandler(notify: (message: string) => void): void {
  if (installed) return;
  installed = true;

  const handle = (signal: "SIGINT" | "SIGTERM") => {
    if (aborting) {
      // Second press: no cleanup, no niceties.
      process.exit(SIGINT_EXIT_CODE);
    }
    aborting = true;
    runInterruptCleanups();
    notify(
      `\n⟁ Scan aborted (${signal}). Any partial results were discarded — re-run with a smaller --times for a quicker sweep.\n`,
    );
    process.exit(SIGINT_EXIT_CODE);
  };

  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}
