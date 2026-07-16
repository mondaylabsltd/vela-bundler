// Types for the virtual `cloudflare:test` module (env, SELF, …) used by the worker runtime
// tests under the @cloudflare/vitest-pool-workers pool, plus the binding shape of `env`.
/// <reference types="@cloudflare/vitest-pool-workers" />
import type { Env } from "../types.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
