import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ["packages/**/*.test.ts", "tooling/**/*.test.ts"],
    passWithNoTests: false,
    sequence: {
      shuffle: true,
    },
  },
});
