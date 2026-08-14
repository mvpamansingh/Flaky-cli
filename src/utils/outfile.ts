import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Writing an export to a user-chosen path — a leaf util (imports nothing else in `src`).
 *
 * Both export flags accept a path (`--html reports/flaky.html`), and a path the user
 * typed may name a directory that doesn't exist yet. Failing with a bare `ENOENT`
 * after a 20-run sweep would be a miserable way to lose the results, so we create the
 * parent directory instead. `recursive: true` also makes it a no-op when it exists.
 */

/** Create the parent directory of `path` if it doesn't exist. */
export async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/** Write `contents` to `path` (UTF-8), creating the parent directory first. */
export async function writeOutputFile(path: string, contents: string): Promise<void> {
  await ensureParentDir(path);
  await writeFile(path, contents, "utf8");
}
