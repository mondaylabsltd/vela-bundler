import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

// Cloudflare Worker runtime tests — exercised under the real workerd pool (miniflare).
export default defineWorkersProject({
  test: {
    name: "workers",
    include: ["worker/tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Disabled: isolated-storage teardown chokes on Durable Object SQLite WAL files
        // (miniflare "Expected .sqlite, got …-shm") once tests exercise DO storage (the
        // chain-registry tests do). Tests that need isolation use distinct DO names.
        isolatedStorage: false,
        main: "./worker/index.ts",
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            BUNDLER: "BundlerDO",
          },
          bindings: {
            OPERATOR_SECRET: "0x" + "ab".repeat(32),
            ALCHEMY_API_KEY: "",
          },
        },
      },
    },
  },
});
