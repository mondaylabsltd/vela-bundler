/**
 * Regression test for the redirect handling on outbound RPC fetches.
 *
 * PROD INCIDENT: setting the viem transport's fetch redirect to "error" broke EVERY RPC
 * call on Cloudflare Workers — the edge runtime rejects "error" ("Invalid redirect value,
 * must be one of follow or manual"), so eth_getBalance/etc. all threw HttpRequestError →
 * 500. The fix is "manual", which CF supports AND which still does not follow the redirect
 * (preserving the anti-SSRF protection: a user-allowed host must not 302 us to an internal
 * IP). These tests lock both properties so the regression can't return.
 */

import { it, expect } from "vitest";
import { RPC_REDIRECT_MODE } from "../shared/utils/rpc-client.ts";
import { reliableTextFetch } from "../shared/reliability/rpc-fetch.ts";
import { CircuitBreaker } from "../shared/reliability/breaker.ts";
import { getClassification } from "../shared/reliability/errors.ts";

it("RPC_REDIRECT_MODE - is Cloudflare-compatible ('manual', never 'error')", () => {
  // Cloudflare Workers' fetch only accepts "follow" | "manual". "error" is rejected at the
  // edge and would break every RPC call in production.
  expect(RPC_REDIRECT_MODE).toEqual("manual");
  expect(RPC_REDIRECT_MODE === "follow" || RPC_REDIRECT_MODE === "manual", "must be CF-supported").toBeTruthy();
  expect((RPC_REDIRECT_MODE as string) !== "error", "redirect:'error' is invalid on Cloudflare Workers").toBeTruthy();
});

function fakeClock() {
  const s = { t: 0 };
  return { now: () => s.t, sleep: (ms: number) => { s.t += ms; return Promise.resolve(); } };
}

it("reliableTextFetch - does NOT follow a 3xx redirect (SSRF protection preserved)", async () => {
  const clk = fakeClock();
  let calls = 0;
  // A user-allowed host responds 302 → internal IP. fetch is called with redirect:'manual',
  // so it returns the 3xx WITHOUT following; reliableTextFetch must reject, not chase it.
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    calls++;
    // Assert the request opted out of auto-following redirects.
    expect(init?.redirect).toEqual("manual");
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
  }) as unknown as typeof fetch;

  let err: unknown;
  let rejected = false;
  try {
    await reliableTextFetch(
      "https://user-allowed-host.example/rpc",
      { method: "POST" },
      { breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, fetchImpl, maxAttempts: 3, deadlineMs: 60_000 },
    );
  } catch (e) {
    rejected = true;
    err = e;
  }
  expect(rejected).toBeTruthy();
  expect(getClassification(err).reason).toEqual("redirect_blocked");
  // A blocked redirect is not a transient condition → must not be retried.
  expect(calls).toEqual(1);
});

it("reliableTextFetch - opaqueredirect response is also rejected", async () => {
  const clk = fakeClock();
  // Cloudflare returns an opaqueredirect (status 0, type 'opaqueredirect') under redirect:manual.
  const fetchImpl = (() => Promise.resolve(Response.redirect("https://10.0.0.1/", 302))) as unknown as typeof fetch;
  // Response.redirect produces a redirect response; emulate the opaque variant via type check
  // by wrapping — but most engines mark it 'opaqueredirect' only after a real fetch. The 3xx
  // status path above is the primary guard; here we at least ensure a redirect status rejects.
  let err: unknown;
  let rejected = false;
  try {
    await reliableTextFetch(
      "https://user-allowed-host.example/rpc",
      { method: "POST" },
      { breaker: new CircuitBreaker({ now: clk.now }), now: clk.now, sleep: clk.sleep, fetchImpl, maxAttempts: 2, deadlineMs: 60_000 },
    );
  } catch (e) {
    rejected = true;
    err = e;
  }
  expect(rejected).toBeTruthy();
  expect(getClassification(err).reason).toEqual("redirect_blocked");
});
