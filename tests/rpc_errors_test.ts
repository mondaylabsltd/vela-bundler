/**
 * Tests for shared/rpc/errors.ts — JSON-RPC error constructors.
 */

import { it, expect } from "vitest";
import {
  parseError,
  invalidRequest,
  invalidParams,
  methodNotFound,
  internalError,
  bundlerError,
} from "../shared/rpc/errors.ts";

it("parseError — returns -32700", () => {
  const err = parseError();
  expect(err.code).toEqual(-32700);
  expect(err.message).toEqual("Parse error");
});

it("invalidRequest — returns -32600 with custom message", () => {
  const err = invalidRequest("bad request");
  expect(err.code).toEqual(-32600);
  expect(err.message).toEqual("bad request");
});

it("invalidParams — returns -32602", () => {
  const err = invalidParams("missing sender");
  expect(err.code).toEqual(-32602);
  expect(err.message).toEqual("missing sender");
});

it("methodNotFound — returns -32601 with method name", () => {
  const err = methodNotFound("eth_foo");
  expect(err.code).toEqual(-32601);
  expect(err.message).toEqual("Method not found: eth_foo");
});

it("internalError — returns -32603", () => {
  const err = internalError("oops");
  expect(err.code).toEqual(-32603);
  expect(err.message).toEqual("oops");
});

it("bundlerError — returns custom code", () => {
  const err = bundlerError(-32500, "simulation failed");
  expect(err.code).toEqual(-32500);
  expect(err.message).toEqual("simulation failed");
});
