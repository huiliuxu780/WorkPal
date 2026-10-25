import { defineConfig } from "vitest/config";
import { unitTestFiles } from "./scripts/testing/test-inventory.mjs";
import baseConfig from "./vitest.config.ts";

const files = unitTestFiles();
const base = baseConfig as {
  test?: Record<string, unknown> & { setupFiles?: string[] };
  [key: string]: unknown;
};

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: files,
    setupFiles: [
      "./scripts/testing/unit-test-env.ts",
      ...(base.test?.setupFiles ?? []),
    ],
  },
});
