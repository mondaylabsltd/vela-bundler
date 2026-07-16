/**
 * Tests for shared/auth/index.ts — rate limiting keyed on TRUSTWORTHY identity only.
 *
 * Security contract (after the SSRF/DoS hardening): the rate-limit bucket is keyed on
 *   1. CF-Connecting-IP (CF edge, unspoofable), else
 *   2. peerAddr — the real TCP peer passed by the Deno server, else
 *   3. a single shared "unknown" bucket.
 * Client-supplied X-Forwarded-For / X-Real-IP are NOT trusted (they were a rate-limit
 * bypass: rotate the header → fresh bucket per request).
 */

import { it, expect } from "vitest";
import { rateLimitGuard, type RateLimitConfig } from "../shared/auth/index.ts";

const config: RateLimitConfig = { rateLimitPerMinute: 3 };

function req(headers?: Record<string, string>): Request {
  return new Request("http://localhost/1", { method: "POST", headers: new Headers(headers ?? {}) });
}

it("rateLimitGuard — allows requests within limit (per peerAddr)", () => {
  const peer = `10.0.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 3; i++) {
    expect(rateLimitGuard(req(), config, peer), `Request ${i + 1} should pass`).toEqual(null);
  }
});

it("rateLimitGuard — blocks after exceeding limit (per peerAddr)", () => {
  const peer = `10.1.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 3; i++) rateLimitGuard(req(), config, peer);
  const result = rateLimitGuard(req(), config, peer);
  expect(result !== null, "Should be rate limited").toBeTruthy();
  expect(result!.status).toEqual(429);
});

it("rateLimitGuard — different peerAddr have separate limits", () => {
  const p1 = `10.2.0.${Math.floor(Math.random() * 255)}`;
  const p2 = `10.3.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 4; i++) rateLimitGuard(req(), config, p1); // exhaust p1
  expect(rateLimitGuard(req(), config, p2), "p2 has its own bucket").toEqual(null);
});

it("rateLimitGuard — prefers CF-Connecting-IP over peerAddr and ignores X-Forwarded-For", () => {
  const cfIp = `10.4.0.${Math.floor(Math.random() * 255)}`;
  const xffIp = `10.5.0.${Math.floor(Math.random() * 255)}`;
  // 3 requests with the same CF IP but ROTATING X-Forwarded-For + rotating peerAddr.
  for (let i = 0; i < 3; i++) {
    rateLimitGuard(req({ "cf-connecting-ip": cfIp, "x-forwarded-for": `${xffIp}${i}` }), config, `peer${i}`);
  }
  // 4th with the same CF IP must be blocked — XFF/peer rotation must NOT mint a new bucket.
  const blocked = rateLimitGuard(req({ "cf-connecting-ip": cfIp, "x-forwarded-for": "9.9.9.9" }), config, "peerX");
  expect(blocked !== null, "CF-Connecting-IP identity must survive XFF/peer rotation").toBeTruthy();
  expect(blocked!.status).toEqual(429);
});

it("rateLimitGuard — does NOT trust X-Forwarded-For / X-Real-IP (spoof rotation can't bypass)", () => {
  // Same peerAddr, attacker rotates XFF and X-Real-IP every request → must still share ONE
  // bucket and get rate limited (the old code minted a fresh bucket per rotated header).
  const peer = `10.6.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 3; i++) {
    rateLimitGuard(req({ "x-forwarded-for": `1.2.3.${i}`, "x-real-ip": `4.5.6.${i}` }), config, peer);
  }
  const blocked = rateLimitGuard(req({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" }), config, peer);
  expect(blocked !== null, "rotating spoofable headers must not bypass the per-peer limit").toBeTruthy();
});

it("rateLimitGuard — returns 429 with JSON body", async () => {
  const peer = `10.7.0.${Math.floor(Math.random() * 255)}`;
  for (let i = 0; i < 4; i++) rateLimitGuard(req(), config, peer);
  const result = rateLimitGuard(req(), config, peer);
  expect(result !== null).toBeTruthy();
  const body = await result!.json();
  expect(body.error).toEqual("Rate limit exceeded");
});
