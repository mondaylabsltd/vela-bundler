import { defineProject } from "vitest/config";

// Shared-logic unit tests (formerly the Deno `deno task test` suite). Ported from
// Deno.test/@std/assert to vitest it/expect. Runs in a plain Node environment — shared/ is
// runtime-agnostic (Web Crypto + fetch only), so no workerd is needed here.
export default defineProject({
  test: {
    name: "node",
    environment: "node",
    include: ["tests/**/*_test.ts"],
  },
});
