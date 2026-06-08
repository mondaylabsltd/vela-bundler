/**
 * Tests for shared/rpc/errors.ts — JSON-RPC error constructors.
 */

import { assertEquals } from "@std/assert";
import {
  parseError,
  invalidRequest,
  invalidParams,
  methodNotFound,
  internalError,
  bundlerError,
} from "../shared/rpc/errors.ts";

Deno.test("parseError — returns -32700", () => {
  const err = parseError();
  assertEquals(err.code, -32700);
  assertEquals(err.message, "Parse error");
});

Deno.test("invalidRequest — returns -32600 with custom message", () => {
  const err = invalidRequest("bad request");
  assertEquals(err.code, -32600);
  assertEquals(err.message, "bad request");
});

Deno.test("invalidParams — returns -32602", () => {
  const err = invalidParams("missing sender");
  assertEquals(err.code, -32602);
  assertEquals(err.message, "missing sender");
});

Deno.test("methodNotFound — returns -32601 with method name", () => {
  const err = methodNotFound("eth_foo");
  assertEquals(err.code, -32601);
  assertEquals(err.message, "Method not found: eth_foo");
});

Deno.test("internalError — returns -32603", () => {
  const err = internalError("oops");
  assertEquals(err.code, -32603);
  assertEquals(err.message, "oops");
});

Deno.test("bundlerError — returns custom code", () => {
  const err = bundlerError(-32500, "simulation failed");
  assertEquals(err.code, -32500);
  assertEquals(err.message, "simulation failed");
});
