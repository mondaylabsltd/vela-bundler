/**
 * Regression test for the Deno streaming body cap (DOS-2): a body larger than the cap is
 * rejected even when Content-Length is absent/lying (chunked transfer), preventing OOM.
 */

import { assertEquals, assert } from "@std/assert";
import { readBodyCapped } from "../deno/server.ts";

const MAX = 256 * 1024;

/** Build a Request whose body streams `total` bytes in chunks, with NO Content-Length. */
function streamingRequest(total: number): Request {
  const chunk = new Uint8Array(16 * 1024).fill(120); // 'x'
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) { controller.close(); return; }
      const n = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  // No content-length header — mimics a chunked upload that bypasses a header-only check.
  return new Request("http://localhost/1", { method: "POST", body, headers: {} });
}

Deno.test("readBodyCapped - returns text for a body within the cap", async () => {
  const req = new Request("http://localhost/1", { method: "POST", body: '{"jsonrpc":"2.0"}' });
  const out = await readBodyCapped(req, MAX);
  assertEquals(out, '{"jsonrpc":"2.0"}');
});

Deno.test("readBodyCapped - rejects an oversized CHUNKED body (no Content-Length) → null", async () => {
  // 1 MB streamed with no Content-Length — a header-only check would have missed it.
  const out = await readBodyCapped(streamingRequest(1024 * 1024), MAX);
  assertEquals(out, null);
});

Deno.test("readBodyCapped - accepts a body exactly at the cap, rejects one byte over", async () => {
  assert((await readBodyCapped(streamingRequest(MAX), MAX)) !== null);
  assertEquals(await readBodyCapped(streamingRequest(MAX + 1), MAX), null);
});

Deno.test("readBodyCapped - empty body returns empty string", async () => {
  const req = new Request("http://localhost/1", { method: "POST" });
  assertEquals(await readBodyCapped(req, MAX), "");
});
