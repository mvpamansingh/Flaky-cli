import figlet from "figlet";
import gradient from "gradient-string";
import { bannerGradient, palette } from "./palette.js";

/**
 * This function renders the Xenolith banner. Degrades gracefully:
 * when stdout is not a TTY (piped / redirected) we  can emit plain text with no ANSI, per the non-negotiable
 * TTY rule.
 */
export function renderBanner(): string {
  const isTty = process.stdout.isTTY ?? false;

  const ascii = figlet.textSync("FLAKY", {
    font: "ANSI Shadow",
    horizontalLayout: "default",
  });

  const tagline = "specimen scanner · flaky-test detective";

  if (!isTty) {
    return `${ascii}\n${tagline}\n`;
  }

  const banner = gradient(bannerGradient as unknown as string[]).multiline(ascii);
  const dimTagline = `\x1b[38;2;107;122;143m${tagline}\x1b[0m`; // palette.muted, truecolor
  void palette;
  return `${banner}\n${dimTagline}\n`;
}
