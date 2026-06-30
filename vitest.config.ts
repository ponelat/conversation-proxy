import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["src/**/*_test.ts", "tests/**/*_test.ts"],
    // Postgres + e2e tests open sockets; give them room and run files in sequence
    // to avoid port/schema contention.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
