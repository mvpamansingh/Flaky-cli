import { expect, test } from 'vitest';

// ─── Flake cause C: time / date dependence ───────────────────────────────────
// Fails depending on WHEN it runs. Here it fails whenever the current second is
// even — so across a sweep of runs spread over real time it flips roughly 50/50,
// surfacing as flaky. Because the "randomness" is really the wall clock, it is
// still internally nondeterministic under isolation (re-running it alone at a
// different second flips it too), but the underlying cause is time, not chance.
//
// Real-world analogues: tests that break at midnight / month boundaries / DST,
// assume "today", depend on timezone, or race a timeout.

test('specimen C — clock-sensitive (fails on even seconds)', () => {
  const second = new Date().getSeconds();
  // Passes on odd seconds, fails on even seconds → ~50% across a real sweep.
  expect(second % 2).toBe(1);
});