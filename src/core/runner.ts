import { spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { execa } from "execa";
import type { Config } from "../config/schema.js";
import type { RawRun } from "../types.js";
import { isAborting, onInterrupt } from "../utils/interrupt.js";
import { toPosix, uniqueResultsPath } from "../utils/tempfile.js";

/**
 * Execute ONE run of the user's test command. I/O only — no parsing.
 *
 * This is the load-bearing robustness module. It bakes in the non-negotiable
 * rules for a single run:
 *   - #2: a non-zero exit code is expected DATA (tests failed), not a crash.
 *         We only mark `crashed` when the runner produced no usable results file.
 *   - #3: a per-run timeout so one hung run can't freeze the sweep.
 *   - #4: results go to a unique temp path per run; we also pre-delete the target
 *         so a crashed run can never be misread as a previous run's stale success.
 *
 * Parsing `resultsXml` into `TestResult[]` is Phase 4's job (`parsers/`).
 */

/** Token users put in `command` to mark where the per-run results path goes. */
const RESULTS_PLACEHOLDER = "{results}";

/** After a timeout SIGTERM, wait this long before escalating to SIGKILL (POSIX). */
const FORCE_KILL_DELAY_MS = 5_000;

/**
 * Ceiling on the Windows process-table read. Generous (it normally takes well under a
 * second) but bounded, so a wedged shell can't hold a user's Ctrl-C hostage.
 */
const PROCESS_TABLE_TIMEOUT_MS = 5_000;

/**
 * Pids of test-command trees we currently own, so an aborting process can take them
 * with it (Phase 9). Only one entry exists at a time in practice — rule #1 makes runs
 * sequential — but a Set costs nothing and doesn't assume that.
 */
const activePids = new Set<number>();

/**
 * Tree-kill every run still in flight. Registered as the Ctrl-C cleanup: on POSIX our
 * children are `detached` (their own process group) specifically so the timeout can
 * tree-kill them, which also means the terminal's Ctrl-C never reaches them — without
 * this, aborting a sweep would leave the user's whole test suite running.
 */
export function killActiveRuns(): void {
  for (const pid of activePids) killTree(pid, "SIGTERM");
  activePids.clear();
}

// Registered once at module load, not per run: `onInterrupt` is idempotent-by-identity
// (a Set), and the function reads `activePids` live, so there's nothing to re-register.
onInterrupt(killActiveRuns);

export interface RunOnceOptions {
  config: Config;
  /** 1-based run number. */
  runIndex: number;
  /**
   * Directory to run the command in. Defaults to `process.cwd()`; callers
   * normally pass the directory containing `flaky.config.json` so the command
   * and `resultsPath` resolve relative to the user's project, not ours.
   */
  cwd?: string;
}

export async function runOnce({
  config,
  runIndex,
  cwd = process.cwd(),
}: RunOnceOptions): Promise<RawRun> {
  const startedAt = new Date().toISOString();

  // --- Decide where results land and how we inject that path ------------------
  // Primary: the command carries a `{results}` placeholder → we substitute a
  // unique temp path and the runner writes straight there (true per-run
  // uniqueness). Fallback: no placeholder → the runner writes to its own
  // configured `resultsPath`; we pre-delete it so a crash can't read stale data.
  const usesPlaceholder = config.command.includes(RESULTS_PLACEHOLDER);
  const tempPath = await uniqueResultsPath(runIndex);
  const expectedFile = usesPlaceholder
    ? tempPath
    : isAbsolute(config.resultsPath)
      ? config.resultsPath
      : resolve(cwd, config.resultsPath);

  const command = usesPlaceholder
    ? config.command.split(RESULTS_PLACEHOLDER).join(toPosix(tempPath))
    : config.command;

  // Rule #4: clear any leftover file so a crashed run can't be mistaken for a
  // successful one via a previous run's results.
  await rm(expectedFile, { force: true });

  // --- Spawn the runner -------------------------------------------------------
  let runnerExitCode = -1;
  let timedOut = false;
  const isWindows = process.platform === "win32";
  try {
    const subprocess = execa(command, {
      shell: true, // command is a full user-provided command line
      cwd,
      reject: false, // rule #2: non-zero exit is data, not a thrown error
      // POSIX: give the child its own process group so we can signal the whole
      // tree (the shell AND everything it spawns). On Windows we use taskkill /T.
      //
      // Windows MUST NOT detach, even though it would fix the Ctrl-C orphan bug
      // (see killTree): `detached` there means DETACHED_PROCESS, which denies the
      // child our console — and a console app like `cmd.exe` responds by
      // allocating its OWN, so every single run of the sweep pops a console
      // window on screen. Tried it; N runs means N flashing windows, which is a
      // far worse defect than the one it fixes.
      detached: !isWindows,
      // Third injection option: reporters that read an env var instead of a
      // flag. It points at the SAME file we read back (`expectedFile`), so a
      // runner using the env var writes exactly where we look — no mismatch.
      env: { ...process.env, FLAKY_RESULTS_PATH: toPosix(expectedFile) },
    });
    const pid = subprocess.pid;
    if (pid !== undefined) activePids.add(pid);

    // Rule #3: per-run timeout with a TREE kill. execa's built-in `timeout` only
    // kills the direct child (the shell); its descendants survive, keep the
    // stdio pipes open, and the run doesn't actually return until they exit
    // (observed: a 500ms timeout still took ~10s). So we time out ourselves and
    // kill the whole process tree — orphans included, so they can't contend for
    // DB/ports/files and manufacture flakiness in later runs.
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      killTree(pid, "SIGTERM");
      if (!isWindows) {
        // SIGKILL backstop for a POSIX tree that ignores SIGTERM. (Windows needs
        // none: `killTree` there is already `taskkill /F`.)
        forceKillTimer = setTimeout(() => killTree(pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
    }, config.timeoutMs);

    try {
      const result = await subprocess;
      runnerExitCode = result.exitCode ?? -1;
    } finally {
      clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      // Don't deregister mid-abort. Ctrl-C often kills the spawned shell, which
      // settles this promise and lands us here — but the cleanup still needs that
      // pid to find the descendants it must kill. Losing the race here is how a
      // whole test suite gets left running.
      if (pid !== undefined && !isAborting()) activePids.delete(pid);
    }
  } catch (err) {
    // With reject:false, execa doesn't throw on non-zero exit — reaching here
    // means the command couldn't be launched at all (e.g. ENOENT). That's a
    // genuine crash, not a test failure.
    return {
      runIndex,
      startedAt,
      runnerExitCode: -1,
      timedOut: false,
      crashed: true,
      crashReason: `Failed to launch test command: ${(err as Error).message}`,
      resultsPath: expectedFile,
    };
  }

  // --- Crash detection (rule #2) ---------------------------------------------
  // The RUNNER blew up only if it produced no usable results file. Tests failing
  // (non-zero exit) with a valid file is normal, expected data.
  try {
    const info = await stat(expectedFile);
    if (info.size === 0) {
      return crash(
        `Results file was empty: ${expectedFile}`,
        runIndex,
        startedAt,
        runnerExitCode,
        timedOut,
        expectedFile,
      );
    }
    const resultsXml = await readFile(expectedFile, "utf8");
    if (resultsXml.trim() === "") {
      return crash(
        `Results file contained only whitespace: ${expectedFile}`,
        runIndex,
        startedAt,
        runnerExitCode,
        timedOut,
        expectedFile,
      );
    }
    return {
      runIndex,
      startedAt,
      runnerExitCode,
      timedOut,
      crashed: false,
      resultsPath: expectedFile,
      resultsXml,
    };
  } catch {
    const reason = timedOut
      ? `Run timed out after ${config.timeoutMs}ms before writing results: ${expectedFile}`
      : `Runner produced no results file at ${expectedFile} (exit ${runnerExitCode}). Check the command and that results land at resultsPath (or use a {results} placeholder).`;
    return crash(reason, runIndex, startedAt, runnerExitCode, timedOut, expectedFile);
  }
}

/**
 * Kill a spawned run and everything it spawned. One helper for both callers (rule #3's
 * timeout and Ctrl-C), because "kill the whole tree, not just the shell" is the same
 * hard-won requirement in both cases — the Decisions log records a 500ms timeout that
 * still took 10s because only the direct child was killed.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // We can't use `taskkill /T` alone. `/T` walks the LIVE parent→child chain,
    // and on Ctrl-C Windows broadcasts the console event to every attached
    // process — so `cmd.exe` (the only pid we hold) is usually dead before we
    // run, the chain to the real test process is severed, and taskkill silently
    // kills nothing. Verified: a hanging grandchild outlived an abort by minutes.
    //
    // The parent *link* survives that death though: a process keeps its recorded
    // ParentProcessId even when that parent is gone. So we read the table
    // ourselves, walk the links down from our shell pid, and kill each pid found.
    //
    // All SYNCHRONOUS: the interrupt handler calls `process.exit()` as soon as
    // cleanups return, so anything async would race our own exit.
    for (const target of windowsDescendants(pid)) {
      spawnSync("taskkill", ["/PID", String(target), "/F"], { stdio: "ignore" });
    }
    return;
  }
  // `detached` made `pid` a process-group leader; a negative pid signals the group.
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited (or was reaped) — nothing left to kill.
  }
}

/** One row of the OS process table: a process and the parent it was spawned by. */
export interface ProcessLink {
  pid: number;
  parentPid: number;
}

/**
 * Every pid in `root`'s subtree, deepest first, including `root` itself. PURE — the
 * process table is passed in, so the tree-walking logic is unit-testable without
 * spawning anything.
 *
 * Deepest-first so we kill leaves before their parents: a dying parent can otherwise
 * get a moment to spawn more work. Cycles are impossible in a real table but a `seen`
 * set makes a corrupt one harmless rather than infinite.
 */
export function descendantClosure(root: number, links: ProcessLink[]): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const { pid, parentPid } of links) {
    const siblings = childrenOf.get(parentPid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(parentPid, [pid]);
  }

  const ordered: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of childrenOf.get(pid) ?? []) visit(child);
    ordered.push(pid); // after its children — post-order gives deepest-first
  };
  visit(root);
  return ordered;
}

/**
 * Read the Windows process table as (pid, parentPid) pairs.
 *
 * PowerShell rather than `wmic`: wmic is deprecated and already removed from recent
 * Windows 11 builds, and this has to work on the machine the user actually has.
 * `windowsHide` matters — an unhidden console app would flash a window on screen,
 * which is the defect that sank the first attempt at this fix.
 *
 * Returns an empty list on any failure (missing shell, timeout, junk output). The
 * caller then falls back to killing just the pid it knows, which is exactly the old
 * behaviour — degraded, never worse.
 */
function readWindowsProcessTable(): ProcessLink[] {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { encoding: "utf8", windowsHide: true, timeout: PROCESS_TABLE_TIMEOUT_MS },
  );

  if (result.error || typeof result.stdout !== "string") return [];

  const links: ProcessLink[] = [];
  for (const line of result.stdout.split("\n")) {
    const [rawPid, rawParent] = line.trim().split(/\s+/);
    const pid = Number(rawPid);
    const parentPid = Number(rawParent);
    if (Number.isInteger(pid) && Number.isInteger(parentPid)) links.push({ pid, parentPid });
  }
  return links;
}

/**
 * Pids to kill for a Windows run: `root` plus everything descended from it.
 *
 * Note the residual risk: we match on pid, and Windows can eventually recycle a pid.
 * The window here is the few hundred milliseconds between the abort and the sweep, so
 * a recycled pid landing in our subtree is vanishingly unlikely — and the alternative
 * (leaving a user's whole suite running) is the certain harm.
 */
function windowsDescendants(root: number): number[] {
  const links = readWindowsProcessTable();
  if (links.length === 0) return [root];
  return descendantClosure(root, links);
}

/** Build a crashed {@link RawRun}. */
function crash(
  crashReason: string,
  runIndex: number,
  startedAt: string,
  runnerExitCode: number,
  timedOut: boolean,
  resultsPath: string,
): RawRun {
  return { runIndex, startedAt, runnerExitCode, timedOut, crashed: true, crashReason, resultsPath };
}
