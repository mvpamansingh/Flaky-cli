export const palette = {
  brand: "#00F5D4", // my hero color bioluminescent cyan — banner, highlights
  secondary: "#5EF38C", // alien green — stable/good
  gradientFrom: "#00F5D4", // cyan
  gradientTo: "#7B2FFF", // violet
  flaky: "#FFB627", // using it amber — flaky rows
  broken: "#FF3864", // hot magenta — consistently-failing
  muted: "#6B7A8F", // secondary info
  dim: "#8892B0", // using it for hints

  // ── Surfaces + ink (Phase 8, export-only) ────────────────────────────────
  // The terminal renderer never paints a background — it inherits the user's
  // terminal. The HTML/PDF exports own their whole page, so they need surface
  // and text tokens that the SPEC §7 table (a *foreground* palette) doesn't
  // cover. All four are contrast-checked against `surface` (dim 6.4:1,
  // muted 4.5:1, ink 17:1 — WCAG AA or better).
  surface: "#070B10", // deep-space page background
  surfaceRaised: "#0E141C", // cards, table header, meter tracks
  border: "#1B2A38", // hairlines between raised surfaces
  ink: "#E6F1F5", // primary text on a dark surface
} as const;

export const bannerGradient = [palette.gradientFrom, palette.gradientTo] as const;
