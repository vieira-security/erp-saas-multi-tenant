import { defineConfig } from "vitest/config";

// Integration tests: real PostgreSQL (TEST_DATABASE_URL), fresh database per run.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.int.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
