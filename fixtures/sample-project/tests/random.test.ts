import { expect, test } from 'vitest';

// ─── Flake cause A: pure randomness ──────────────────────────────────────────
// Internally nondeterministic. Fails ~30% of the time on identical code, with
// no dependence on order, time, or shared state. This is the archetypal flake:
// re-running the SAME test alone still flips (Phase 7 should classify it
// "internally-nondeterministic").
//
// Real-world analogue: a test that asserts on Math.random(), an unseeded UUID,
// a race between two async operations, floating-point jitter, etc.

test('specimen A — coin flip (fails ~30% at random)', () => {
  const roll = Math.random();
  // Passes 70% of the time, fails 30% of the time.
  expect(roll).toBeGreaterThan(0.3);
});