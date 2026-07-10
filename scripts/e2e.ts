#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run --env
/**
 * Local end-to-end harness for the Deno runtime.
 *
 * Boots `deno/main.ts` on a test port, then exercises four dimensions the way an SRE would
 * gate a release:
 *   - ACCURACY     — responses are correct & derivations are deterministic/consistent
 *   - RELIABILITY  — abuse/edge inputs are rejected with the right status (SSRF, caps, bad input)
 *   - STABILITY    — sustained load leaves the process healthy (no crash / health stays ok)
 *   - PERFORMANCE  — latency + throughput of hot endpoints
 * Then, if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set, it runs a LIVE treasury-alert check
 * that actually delivers a Telegram message via the real monitor path.
 *
 * Usage:  deno task e2e            (uses .env; generates a throwaway OPERATOR_SECRET if unset)
 * Exit code is non-zero if any check fails.
 */

import { checkTreasuryBalance } from "../shared/monitoring/treasury.ts";
import { checkOperationalHealth, DEFAULT_OPERATIONAL_THRESHOLDS } from "../shared/monitoring/operational.ts";
import { createAlerter, NoopAlerter } from "../shared/monitoring/telegram.ts";
import type { PublicClient, Transport, Chain } from "viem";

const PORT = Number(Deno.env.get("E2E_PORT") ?? "3555");
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Tiny assertion + reporting harness
// ---------------------------------------------------------------------------
type Check = { dim: string; name: string; ok: boolean; detail: string };
const results: Check[] = [];
function record(dim: string, name: string, ok: boolean, detail = "") {
  results.push({ dim, name, ok, detail });
  const mark = ok ? "✓" : "✗";
  console.log(`  ${mark} [${dim}] ${name}${detail ? " — " + detail : ""}`);
}
async function expectStatus(dim: string, name: string, p: Promise<Response>, want: number) {
  try {
    const res = await p;
    await res.body?.cancel();
    record(dim, name, res.status === want, `got ${res.status}, want ${want}`);
  } catch (e) {
    record(dim, name, false, `threw: ${e instanceof Error ? e.message : e}`);
  }
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Boot the server
// ---------------------------------------------------------------------------
async function waitForHealth(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/health");
      await r.body?.cancel();
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!Deno.env.get("OPERATOR_SECRET")) {
    // Throwaway secret for a hermetic run (no real funds involved).
    Deno.env.set("OPERATOR_SECRET", "0x" + "ab".repeat(32));
  }

  console.log(`\n▶ Booting Deno bundler on :${PORT} …`);
  const server = new Deno.Command("deno", {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", "deno/main.ts"],
    // Raise the per-IP rate limit for the harness so STABILITY/PERFORMANCE measure real server
    // capacity rather than the limiter (the limiter itself is covered by tests/rate_limit_test.ts).
    env: { ...Deno.env.toObject(), PORT: String(PORT), API_RATE_LIMIT_PER_MINUTE: "1000000" },
    stdout: "null",
    stderr: "null",
  }).spawn();

  try {
    if (!(await waitForHealth())) {
      console.error("✗ Server did not become healthy — aborting.");
      Deno.exit(1);
    }
    console.log("  server healthy.\n");

    // ---- ACCURACY ----
    console.log("ACCURACY");
    {
      const h = await (await fetch(BASE + "/health")).json();
      record("accuracy", "health service identity", h.service === "vela-bundler" && h.status === "ok", `status=${h.status}`);

      const chainIds = [1, 137, 8453];
      for (const id of chainIds) {
        const r = await (await post(`/${id}`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })).json();
        record("accuracy", `eth_chainId(/${id}) == 0x${id.toString(16)}`, r.result === "0x" + id.toString(16), `got ${r.result}`);
      }

      const eps = await (await post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_supportedEntryPoints", params: [] })).json();
      record("accuracy", "eth_supportedEntryPoints is EP v0.7",
        Array.isArray(eps.result) && eps.result[0]?.toLowerCase() === "0x0000000071727de22e5e9d8baf0edac6f37da032",
        `${eps.result?.[0]}`);

      // Treasury/splitter derivation is deterministic + mutually consistent.
      const t1 = await (await fetch(BASE + "/v1/treasury")).json();
      const t2 = await (await fetch(BASE + "/v1/treasury")).json();
      record("accuracy", "treasury derivation deterministic", t1.address && t1.address === t2.address, t1.address);
      const sp = await (await fetch(BASE + "/v1/splitter")).json();
      record("accuracy", "splitter reports same treasury", sp.treasury?.toLowerCase() === t1.address?.toLowerCase(), `${sp.treasury}`);
      record("accuracy", "splitter address is a 20-byte address", /^0x[0-9a-fA-F]{40}$/.test(sp.address ?? ""), sp.address);
    }

    // ---- RELIABILITY (abuse / edge inputs rejected correctly) ----
    console.log("\nRELIABILITY");
    await expectStatus("reliability", "SSRF X-Rpc-Url → metadata IP blocked",
      post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { "X-Rpc-Url": "https://169.254.169.254/" }), 400);
    await expectStatus("reliability", "SSRF X-Rpc-Url → loopback blocked",
      post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { "X-Rpc-Url": "https://127.0.0.1/" }), 400);
    await expectStatus("reliability", "SSRF X-Rpc-Url → non-https blocked",
      post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { "X-Rpc-Url": "http://example.com/" }), 400);
    await expectStatus("reliability", "batch > 20 rejected",
      post(`/1`, Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] }))), 400);
    await expectStatus("reliability", "body > 256KB rejected (413)",
      post(`/1`, '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":["' + "A".repeat(270_000) + '"]}'), 413);
    await expectStatus("reliability", "invalid chainId path rejected",
      post(`/0`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), 400);
    await expectStatus("reliability", "non-POST JSON-RPC path rejected (405)", fetch(BASE + "/1"), 405);
    {
      const r = await (await post(`/1`, "{ not json")).json();
      record("reliability", "malformed JSON → parse error", r.error?.code === -32700, `code=${r.error?.code}`);
      const u = await (await post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_notAMethod", params: [] })).json();
      record("reliability", "unknown method → JSON-RPC error", !!u.error, `code=${u.error?.code}`);
      // Batch of exactly 20 is allowed.
      const ok20 = await post(`/1`, Array.from({ length: 20 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] })));
      const arr = await ok20.json();
      record("reliability", "batch == 20 allowed", Array.isArray(arr) && arr.length === 20, `len=${arr.length}`);
    }

    // ---- STABILITY (sustained load, process stays healthy) ----
    console.log("\nSTABILITY");
    {
      const N = 600;
      let ok = 0;
      const t0 = performance.now();
      for (let i = 0; i < N; i += 30) {
        const batch = await Promise.all(
          Array.from({ length: 30 }, () =>
            post(`/1`, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] })
              .then((r) => r.json()).then((j) => j.result === "0x1").catch(() => false)),
        );
        ok += batch.filter(Boolean).length;
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      record("stability", `${N} concurrent-ish JSON-RPC calls all correct`, ok === N, `${ok}/${N} in ${secs}s`);
      const stillUp = await waitForHealth(3000);
      record("stability", "server still healthy after load", stillUp);
    }

    // ---- PERFORMANCE (latency + throughput) ----
    console.log("\nPERFORMANCE");
    {
      const samples: number[] = [];
      const N = 200;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const s = performance.now();
        const r = await fetch(BASE + "/health");
        await r.body?.cancel();
        samples.push(performance.now() - s);
      }
      const total = performance.now() - t0;
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(N * 0.5)]!.toFixed(2);
      const p95 = samples[Math.floor(N * 0.95)]!.toFixed(2);
      const rps = (N / (total / 1000)).toFixed(0);
      record("performance", "/health latency measured", true, `p50=${p50}ms p95=${p95}ms ~${rps} rps (serial)`);
      // Loose sanity ceiling so a pathological regression fails the gate.
      record("performance", "/health p95 < 100ms", Number(p95) < 100, `p95=${p95}ms`);
    }

    // ---- ALERTING (live Telegram, opt-in via env) ----
    console.log("\nALERTING (treasury monitor → Telegram)");
    {
      const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? null;
      const chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? null;
      const alerter = createAlerter({ telegramBotToken: botToken, telegramChatId: chatId });
      if (alerter instanceof NoopAlerter) {
        record("alerting", "Telegram live send", true, "SKIPPED — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env to run");
      } else {
        // (1) Verify the bot credentials are valid (deterministic, doesn't message the chat).
        try {
          const me = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then((r) => r.json()) as { ok: boolean; result?: { username?: string } };
          record("alerting", "Telegram bot credentials valid (getMe ok)", me.ok === true, me.ok ? `@${me.result?.username}` : "getMe returned not-ok — check TELEGRAM_BOT_TOKEN");
        } catch (e) {
          record("alerting", "Telegram bot credentials valid (getMe ok)", false, `getMe threw: ${e instanceof Error ? e.message : e}`);
        }
        // (2) Confirm end-to-end DELIVERY: send a real message and assert the API accepted it.
        try {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: "✅ Vela Bundler e2e: treasury-alert delivery check (test message)", disable_web_page_preview: true }),
          });
          const body = await res.json() as { ok: boolean; description?: string };
          record("alerting", "Telegram message delivered (API ok:true)", res.ok && body.ok === true, body.ok ? "delivered to chat" : `rejected: ${body.description}`);
        } catch (e) {
          record("alerting", "Telegram message delivered (API ok:true)", false, `send threw: ${e instanceof Error ? e.message : e}`);
        }
        // (3) Confirm the PRODUCTION treasury monitor path fires an alert (live) on low balance.
        const mockClient = { getBalance: () => Promise.resolve(1n), readContract: () => Promise.resolve(1n) } as unknown as PublicClient<Transport, Chain>;
        const monRes = await checkTreasuryBalance({
          chainId: 1, chainName: "E2E-Test (synthetic low balance)", treasuryAddress: ("0x" + "ab".repeat(20)) as `0x${string}`,
          client: mockClient, thresholdWei: 10n ** 30n, thresholdPathUsd: 0n, alerter,
        });
        record("alerting", "treasury monitor fires on below-threshold balance", monRes?.belowThreshold === true, "monitor→alerter path exercised (live)");

        // (4) Confirm the PRODUCTION operational monitor fires a live "stuck-money" alert so the
        //     operator sees a real example of the intervention notification.
        let opAlertSent = false;
        const opAlerter = {
          enabled: alerter.enabled,
          send: (id: string, msg: string, opts?: { cooldownMs?: number; noEscalation?: boolean }) => {
            opAlertSent = true;
            return alerter.send(id, msg, opts);
          },
        };
        await checkOperationalHealth(
          {
            chainId: 1, chainName: "E2E-Test (synthetic stuck EOA)", oldestMempoolAgeMs: 0,
            lockedEoaCount: 1, oldestLockedAgeMs: 600_000, pendingReceiptCount: 0,
            oldestPendingReceiptAgeMs: 0, circuitDegraded: 0, reputationBannedSenders: 0,
            submitFailureStreak: 0, lastSubmitError: null, insufficientFundsEoa: null,
          },
          DEFAULT_OPERATIONAL_THRESHOLDS, opAlerter,
        );
        record("alerting", "operational monitor fires a live stuck-EOA alert", opAlertSent, "stuck-money → intervention alert delivered (live)");
      }
    }

    // ---- Report ----
    const failed = results.filter((r) => !r.ok);
    const byDim = [...new Set(results.map((r) => r.dim))];
    console.log("\n──────── SUMMARY ────────");
    for (const d of byDim) {
      const dr = results.filter((r) => r.dim === d);
      console.log(`  ${d.padEnd(12)} ${dr.filter((r) => r.ok).length}/${dr.length} passed`);
    }
    console.log(`  ${"TOTAL".padEnd(12)} ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log("\n✗ FAILURES:");
      for (const f of failed) console.log(`  - [${f.dim}] ${f.name} (${f.detail})`);
      Deno.exit(1);
    }
    console.log("\n✓ ALL E2E CHECKS PASSED");
  } finally {
    try { server.kill("SIGTERM"); } catch { /* already gone */ }
    await server.status.catch(() => {});
  }
}

if (import.meta.main) await main();
