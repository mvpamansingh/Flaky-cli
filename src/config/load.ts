import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { z } from "zod";
import { type Config, configSchema } from "./schema.js";

/** Default config location, relative to the current working directory. */
export const DEFAULT_CONFIG_PATH = "./flaky.config.json";

/**
 * Thrown for any user-facing config problem (missing file, bad JSON, failed
 * validation). Carries an already-formatted, multi-line message the command
 * layer can print verbatim — no stack trace noise for the user.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Find + read + validate `flaky.config.json`.
 *
 * Distinguishes the three failure modes a user actually hits and gives each a
 * clear, actionable message:
 *   1. file not found        → tell them to run `flaky init`
 *   2. malformed JSON         → point at the syntax error
 *   3. schema violations      → list every offending field at once
 */
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<Config> {
  const absPath = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        `No config found at ${absPath}\n  → Run \`flaky init\` to create one, or pass --config <path>.`,
      );
    }
    throw new ConfigError(`Could not read config at ${absPath}\n  → ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config at ${absPath} is not valid JSON\n  → ${(err as Error).message}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Config at ${absPath} is invalid:\n${formatIssues(result.error)}`);
  }

  return result.data;
}

/** Turn a ZodError into a readable, per-field bullet list. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}
