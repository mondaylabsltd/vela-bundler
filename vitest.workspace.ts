import { defineWorkspace } from "vitest/config";

// Two projects:
//   node    — shared/ logic unit tests (tests/**), plain Node environment. shared/ uses only
//             Web-standard APIs (crypto.subtle, fetch, TextEncoder), all present in Node 20+.
//   workers — worker/ runtime tests (worker/tests/**) under the real workerd pool (miniflare).
export default defineWorkspace([
  "./vitest.node.config.ts",
  "./vitest.workers.config.ts",
]);
