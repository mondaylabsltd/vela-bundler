# 01 — System Overview

> Takeover baseline commit: `4beaaef` (2026-07-07). Audit date: 2026-07-09.
> This document describes verified behavior of the code at that commit. Claims are cited to
> `file:line`. Anything marked **UNVERIFIED** was not exercised end-to-end.

## What this is

**Vela Bundler** is an ERC-4337 / ERC-7769 **multi-chain bundler for EntryPoint v0.7**. It is a
**private, prepaid bundler** built for the Vela / biubiu wallet ecosystem — not a generic public
bundler. Its distinguishing design: **each user Safe gets its own dedicated bundler EOA**, whose
private key is deterministically derived from the operator secret. Users prepay gas by depositing
native tokens (or a stablecoin float on Tempo) to that EOA; the bundler submits `handleOps` from it.

- Entry point contract: `0x0000000071727De22E5E9d8BAf0edAc6f37da032` (EntryPoint v0.7), configurable via `ENTRY_POINT_ADDRESS`.
- Language/runtime: **TypeScript**, deployed to **Cloudflare Workers** only (`worker/`), one **Durable Object per chain** (`BundlerDO`), over a shared `shared/` core — see [05-deployment-runbook.md](05-deployment-runbook.md).
- On-chain deps: **viem 2.52.2**; a vendored Foundry contract `VelaGasSettlementSplitter` (`evm_contracts/`).
- **No database.** All state is either derived (keys/addresses) or in-memory (mempool, reservations, EOA locks). The Worker runtime additionally persists a small amount to DO storage (chainId, pending receipts, decay timestamp).

## Core business flow (the money path)

1. **Key derivation** ([shared/keys/derive.ts](../../shared/keys/derive.ts)): `HKDF-SHA256(IKM=operatorSecret, salt="vela-bundler-dedicated-eoa-v1", info="chainId=…|entryPoint=…|safeAddress=…")` → secp256k1 private key → EOA address. A counter is appended and re-derived if the output is out of curve range. The **treasury** key is derived the same way with a fixed `info="treasury"`, so the treasury address is identical on every chain.
2. **Deposit**: the user funds their derived EOA (native token; on Tempo a `pathUSD` stablecoin float).
3. **Submit**: `eth_sendUserOperation` validates, simulates, and enqueues the op ([shared/rpc/handlers.ts](../../shared/rpc/handlers.ts), [shared/mempool/](../../shared/mempool/)).
4. **Bundle**: an auto-bundle tick (Deno `setInterval` via ChainRegistry, or Worker DO alarm every 10s) builds a bundle **containing ops from a single Safe only**, re-validates, simulates, checks profitability/balance, then signs and broadcasts `handleOps` from the dedicated EOA ([shared/bundler/index.ts:270-668](../../shared/bundler/index.ts#L270)).
5. **Settlement**:
   - **Native chains**: the `handleOps` **beneficiary is the `VelaGasSettlementSplitter`** ([shared/bundler/index.ts:405](../../shared/bundler/index.ts#L405)). The EntryPoint pays the collected gas fee to the splitter, whose `receive()` sends 50% to `tx.origin` (the EOA) and 50% to the treasury ([evm_contracts/src/VelaGasSettlementSplitter.sol](../../evm_contracts/src/VelaGasSettlementSplitter.sol)).
   - **Tempo (chain-specific 0x76 tx type)**: EntryPoint refund is 0; the bundler is repaid by an in-band stablecoin transfer batched into the UserOp. The beneficiary **must** stay the EOA there, and reimbursement is checked **fail-closed** before submit ([shared/bundler/index.ts:433-482](../../shared/bundler/index.ts#L433)).
6. **Reconciliation**: after broadcast the EOA is locked (`LOCKED_PENDING_UNKNOWN`) and a receipt poll runs (Deno: background promise; Worker: alarm-driven `checkPendingReceipts`). On receipt/drop/timeout the balance reservation is released and the EOA nonce is refreshed ([shared/bundler/index.ts:738-960](../../shared/bundler/index.ts#L738)).

## Module map (`shared/`)

| Module | Responsibility | Key files |
|--------|----------------|-----------|
| `keys/` | Deterministic EOA + treasury key derivation (HKDF-SHA256), key manager, old-secret rotation | `derive.ts`, `local.ts`, `types.ts` |
| `account/` | Per-EOA balance, in-memory reservations, per-EOA bundle lock + nonce state, sponsorship | `index.ts`, `eoa-lock.ts`, `sponsor.ts` |
| `contracts/` | EntryPoint v0.7 ABI + constants + error codes; CREATE2 splitter derivation | `entrypoint.ts`, `splitter.ts` |
| `userop/` | UserOperation types, packing, hashing, field validation | `validate.ts`, `pack.ts`, `hash.ts`, `types.ts` |
| `gas/` | preVerificationGas, L2 data fee, profitability + outer-tx fee model | `preVerificationGas.ts`, `l2-data-fee.ts`, `profitability.ts`, `fee-model.ts` |
| `simulation/` | `simulateValidation`, bundle/execution simulation, error decoding | `index.ts` |
| `mempool/` | In-memory mempool with reputation tracking, size caps | `index.ts` |
| `bundler/` | Bundle building, submission, receipt reconciliation, pending persistence hook | `index.ts` (1148 LOC) |
| `chain/` | Per-chain service registry (lazy init + health loop), chain metadata resolution | `index.ts` |
| `config/` | Config types, chain registry, Alchemy RPC resolution | `types.ts`, `chain-registry.ts` |
| `rpc/` | JSON-RPC handlers, REST API, per-request processing, CORS, errors | `handlers.ts`, `rest-api.ts`, `process.ts`, `cors.ts`, `errors.ts` |
| `auth/` | IP-keyed rate limiting | `index.ts` |
| `reliability/` | Retries, circuit breaker, error classification, RPC fetch, structured logging + metrics | `retry.ts`, `breaker.ts`, `errors.ts`, `rpc-fetch.ts`, `log.ts` |
| `utils/` | Hex helpers, viem client factory, **SSRF-validating RPC URL check**, timeouts, RPC blacklist | `rpc-client.ts`, `hex.ts`, `timeout.ts`, `rpc-blacklist.ts` |
| `tempo.ts` | All Tempo-chain (0x76 tx) specifics: fee token, cost math, reimbursement parsing, sponsorship | `tempo.ts` |

## Runtime

**Cloudflare Workers** (`worker/`) is the only deployment target. (The former Deno self-hosted server, `deno/`, was removed 2026-07-16 — see the migration banner in [README.md](README.md).)

### Cloudflare Workers (`worker/`)
- `index.ts` — fetch handler; routes `POST /:chainId` → `env.BUNDLER.idFromName("chain-${chainId}")`.
- `bundler-do.ts` — `BundlerDO` Durable Object, one per chain. Encapsulates mempool, locks, reputation, sponsor. Auto-bundling + reconciliation + reputation decay run on a **10s alarm** that persists across eviction. Persists `chainId`, `pendingReceipts`, and `lastDecayAt` to DO storage. Rate-limits by `CF-Connecting-IP`.
- `config.ts` / `types.ts` — env bindings → `BundlerConfig`.

## RPC URL priority & SSRF posture

Effective RPC per request: **`X-Rpc-Url` header** (validated, read-only use) > **Alchemy** (if `ALCHEMY_API_KEY` set and chain supported) > **chain registry public RPCs** (health-checked). The user-supplied `X-Rpc-Url` is **never** used for signing/broadcast or for the treasury-moving sponsor path — those force the trusted registry RPC ([shared/bundler/index.ts:561-568](../../shared/bundler/index.ts#L561), [shared/rpc/rest-api.ts:183-188](../../shared/rpc/rest-api.ts#L183)). URL validation blocks non-HTTPS, credentials, loopback, RFC1918/link-local, IPv6 loopback/ULA/mapped, and cloud-metadata endpoints ([shared/utils/rpc-client.ts:45-156](../../shared/utils/rpc-client.ts#L45)).

## API surface

**JSON-RPC** (`POST /:chainId`, batch capped at 20): `eth_sendUserOperation`, `eth_estimateUserOperationGas`, `eth_getUserOperationByHash`, `eth_getUserOperationReceipt`, `eth_supportedEntryPoints`, `eth_chainId`, plus `pimlico_getUserOperationGasPrice` (price quote source of truth).

**REST**: `GET /v1/account/:chainId/:safeAddress`, `GET /v1/treasury`, `GET /v1/splitter`, `POST /v1/sponsor/:chainId/:safeAddress`, `GET /health`.

## Assessment: not a demo

Traced end-to-end, the money path shows production-grade care: fail-closed Tempo reimbursement checks, trusted-RPC-only broadcast, dropped-tx detection during reconciliation, reservation release in `finally`, bounded in-memory maps with lossless eviction, CREATE2-deterministic beneficiary, thorough SSRF validation, IP-based (non-spoofable) rate limiting, hardened systemd unit, and DO-storage durability for in-flight bundles. This is a **production-intent system**, not a prototype. Remaining gates to launch are tracked in [04-production-readiness.md](04-production-readiness.md).
