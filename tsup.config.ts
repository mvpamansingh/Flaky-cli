import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  // Preserve the shebang so the built file is directly executable.
  banner: {
    js: "#!/usr/bin/env node",
  },
});
