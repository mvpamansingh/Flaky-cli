import { expect, test } from 'vitest';

// ─── Flake cause B: order / shared-state dependence ──────────────────────────
// A victim test that is correct in isolation but fails because a DIFFERENT test
// mutated shared module-level state before it ran. Nothing here is random or
// time-based: given a fixed run order it is 100% deterministic. It only *looks*
// flaky at the suite level because whether the polluter runs first can change.
//
// Vitest runs tests WITHIN one file top-to-bottom, so the polluter below always
// runs before the victim → the victim fails every time in the full suite.
// But run the victim ALONE (`vitest run -t "victim"`) and it passes, because
// the polluter never executes. That pass-alone / fail-in-suite split is the
// signature Phase 7 isolation diagnosis uses to label it "order-dependent".
//
// (Shared state must live in the SAME file: Vitest isolates test files into
// separate workers, so cross-file module state would not carry over.)

interface SharedResource {
  connections: number;
}

// Simulates a shared resource (DB pool, global cache, singleton) that every
// test assumes starts clean.
const resource: SharedResource = { connections: 0 };

test('polluter — leaks a connection into shared state', () => {
  // A badly-behaved test that acquires a resource and forgets to release it.
  resource.connections += 1;
  expect(resource.connections).toBeGreaterThan(0);
});

test('victim B — assumes a clean resource (fails after the polluter)', () => {
  // Correct in isolation: a freshly-initialized resource has zero connections.
  // Fails in the suite only because the polluter above leaked one first.
  expect(resource.connections).toBe(0);
});