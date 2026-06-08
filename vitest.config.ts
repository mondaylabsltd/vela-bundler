import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker/tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        isolatedStorage: true,
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
