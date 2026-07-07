
export const palette = {
  brand: "#00F5D4", // my hero color bioluminescent cyan — banner, highlights
  secondary: "#5EF38C", // alien green — stable/good
  gradientFrom: "#00F5D4", // cyan
  gradientTo: "#7B2FFF", // violet
  flaky: "#FFB627", // using it amber — flaky rows
  broken: "#FF3864", // hot magenta — consistently-failing
  muted: "#6B7A8F", // secondary info
  dim: "#8892B0", // using it for hints
} as const;


export const bannerGradient = [palette.gradientFrom, palette.gradientTo] as const;
