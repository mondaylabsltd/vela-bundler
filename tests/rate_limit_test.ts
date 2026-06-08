/**
 * Tests for shared/auth/index.ts — rate limiting with CF-Connecting-IP support.
 */

import { assertEquals, assert } from "@std/assert";
import { rateLimitGuard, type RateLimitConfig } from "../shared/auth/index.ts";

const config: RateLimitConfig = { rateLimitPerMinute: 3 };

function makeRequest(ip: string, headers?: Record<string, string>): Request {
  const h = new Headers(headers ?? {});
  if (!h.has("cf-connecting-ip") && !h.has("x-forwarded-for") && !h.has("x-real-ip")) {
    h.set("x-forwarded-for", ip);
  }
  return new Request("http://localhost/1", { method: "POST", headers: h });
}

Deno.test("rateLimitGuard — allows requests within limit", () => {
  // Use unique IPs to avoid cross-test pollution
  const ip = `10.0.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 3; i++) {
    const result = rateLimitGuard(makeRequest(ip), config);
    assertEquals(result, null, `Request ${i + 1} should pass`);
  }
});

Deno.test("rateLimitGuard — blocks after exceeding limit", () => {
  const ip = `10.1.0.${Math.floor(Math.random() * 255)}`;
  // Exhaust the limit
  for (let i = 0; i < 3; i++) {
    rateLimitGuard(makeRequest(ip), config);
  }
  // Next request should be blocked
  const result = rateLimitGuard(makeRequest(ip), config);
  assert(result !== null, "Should be rate limited");
  assertEquals(result!.status, 429);
});

Deno.test("rateLimitGuard — different IPs have separate limits", () => {
  const ip1 = `10.2.0.${Math.floor(Math.random() * 255)}`;
  const ip2 = `10.3.0.${Math.floor(Math.random() * 255)}`;

  // Exhaust ip1's limit
  for (let i = 0; i < 4; i++) {
    rateLimitGuard(makeRequest(ip1), config);
  }

  // ip2 should still pass
  const result = rateLimitGuard(makeRequest(ip2), config);
  assertEquals(result, null);
});

Deno.test("rateLimitGuard — prefers CF-Connecting-IP over X-Forwarded-For", () => {
  const cfIp = `10.4.0.${Math.floor(Math.random() * 255)}`;
  const xffIp = `10.5.0.${Math.floor(Math.random() * 255)}`;

  // Send 3 requests with CF-Connecting-IP
  for (let i = 0; i < 3; i++) {
    rateLimitGuard(makeRequest("", {
      "cf-connecting-ip": cfIp,
      "x-forwarded-for": xffIp,
    }), config);
  }

  // 4th request with same CF IP should be blocked
  const blocked = rateLimitGuard(makeRequest("", {
    "cf-connecting-ip": cfIp,
    "x-forwarded-for": xffIp,
  }), config);
  assert(blocked !== null, "Should be rate limited by CF-Connecting-IP");

  // Request with only XFF IP should NOT be blocked (different identity)
  const xffReq = makeRequest(xffIp);
  const notBlocked = rateLimitGuard(xffReq, config);
  assertEquals(notBlocked, null, "XFF IP should have its own bucket");
});

Deno.test("rateLimitGuard — uses x-real-ip as fallback", () => {
  const ip = `10.6.0.${Math.floor(Math.random() * 255)}`;
  const req = new Request("http://localhost/1", {
    method: "POST",
    headers: { "x-real-ip": ip },
  });

  const result = rateLimitGuard(req, config);
  assertEquals(result, null);
});

Deno.test("rateLimitGuard — returns 429 with JSON body", async () => {
  const ip = `10.7.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 4; i++) {
    rateLimitGuard(makeRequest(ip), config);
  }
  const result = rateLimitGuard(makeRequest(ip), config);
  assert(result !== null);
  const body = await result!.json();
  assertEquals(body.error, "Rate limit exceeded");
});
