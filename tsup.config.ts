import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    main: "src/main.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Resolve the "@/..." alias for the bundle (dts uses tsconfig paths).
  esbuildOptions(options) {
    options.alias = { "@": resolve(root, "src") };
  },
});
