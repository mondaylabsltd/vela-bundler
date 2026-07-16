# In-band gas settlement (generalize Tempo to all EVM chains)

Status: in progress. Supersedes the abandoned paymaster idea (paymaster contract deleted).

## Model — one route, all in-band

Every sponsored UserOp is signed with `maxFeePerGas = maxPriorityFeePerGas = 0`, so the
EntryPoint's native prefund/refund accounting is a no-op. The per-safe bundler EOA fronts the real
L1 gas; the user's op batches an **in-band transfer to that EOA** covering it. Before submitting,
the bundler proves execution via `eth_simulateV1`, prices its real gas from `gasUsed`, and refuses
to submit unless `reimbursed >= required`. This is exactly today's Tempo path, generalized.

- **Route-A (native self-pay via EntryPoint + VelaGasSettlementSplitter + 2× reserve) is DELETED.**
  Native users also go in-band (batch a native transfer to the EOA). Operator revenue comes from
  the margin below, not the splitter's 50/50 cut.
- **No paymaster, no splitter, no EntryPoint deposit, no on-chain contract for this.**

## Pricing

- `cost` = real L1 gas the bundler pays = `(simGasUsed + BUFFER) × outerMaxFeePerGas` (native wei).
- **Charge = 3× cost.** `required_native = 3 × cost`.
- **Stablecoin path adds a floor:** `required_stable = max($0.01 in stable units, 3 × cost_in_stable)`.
- Sizing is done by a **bundler quote** (quote-then-verify); the wallet transfers exactly the
  quoted amount; the bundler re-verifies at submit against its cached rate.

## Fee assets

- **Native** (primary, same-asset): in-band native transfer to the EOA; compare wei-to-wei, no rate.
- **Whitelisted stablecoins**: in-band `stable.transfer(EOA, amount)`; valued via the rate below.
  Whitelist per chain from `https://ethereum-data.awesometools.dev/chains/eip155-<chainId>.json`
  → `stables[].contract` (e.g. mainnet: USDC/USDT). Timed-fetch + cache, config snapshot as fallback.
  Only whitelisted tokens count as reimbursement (anti-drain).

## Rate (native ↔ stablecoin) — on-chain DEX quote

The same list gives, per chain: `wrappedNativeToken` (WETH), `dex.contracts.quoterV2`
(Uniswap v3 QuoterV2), `nativeCurrency.decimals`. The bundler calls
`quoterV2.quoteExactInputSingle(WETH → stable, amountIn = cost_native)` via `eth_call` to get the
market rate, cached ~30–60s. No external price API, no oracle config beyond the list. Chains with no
`dex` in the list → native-only (no stablecoin gas there).

## Anti-drain guards (carried from parseTempoReimbursement)

Only count a MultiSend entry when: `operation == 0` (plain CALL, not DELEGATECALL — a delegatecall
to the token moves nothing), `to == the exact EOA`, and the asset is native **value** or an
**allowlisted** stablecoin `transfer`. Reads SIGNED calldata, never a wallet-supplied amount.

## Two orthogonal predicates (the refactor seam)

- `opIsInBand(op)` = `op.maxFeePerGas === 0n`.
- `chainSupportsInBand(chainId, config)` = `isTempoChain(chainId) || config.inBandEnabled`.
- **`inBand`** (settlement) = `opIsInBand(op) && chainSupportsInBand(chainId)` → drives beneficiary
  (EOA), outer pricing (network), the `reimbursed>=required` gate, reservation-skip.
- **`tempoEnvelope`** = `isTempoChain(chainId)` → drives ONLY the tx envelope (0x76 vs native
  EIP-1559 raw tx), float asset (pathUSD vs native), trusted-RPC forcing, verification-gas ceiling.
- Tempo = inBand + tempoEnvelope. Generic = inBand + native envelope (reuses existing native
  broadcast path verbatim).

## Float / rebalance

EOA fronts native (operator-funded, continuous top-up like `_doSponsorTempo`, but native + not
nonce-gated). Collected stablecoin swept to treasury; treasury rebalances stable→native in bulk
(keeper). Native in-band self-heals (front native, repaid native, same atomic tx).

## Config (per chain, synced from the list)

`{ inBandEnabled, wrappedNative, quoterV2, feeTier, stables[], nativeDecimals }`.

## Wallet

Pick native or an allowlisted stablecoin → get bundler quote → batch a plain-CALL transfer to the
EOA (native value, or `stable.transfer(EOA, amount)`) as a MultiSend entry → sign with `maxFee = 0`.

## Implementation order (smallest-safe-first; tests are the zero-change gate)

1. **Pure refactor**: add the two predicates; rewire settlement concerns (beneficiary, reservation,
   gate) from `tempo` to `inBand`; keep envelope/asset/RPC/verif on `isTempoChain`. `inBandEnabled`
   default false off-Tempo ⇒ dead branches ⇒ identical behavior; Tempo byte-identical; tests green.
2. Generalize `parseTempoReimbursement` → `parseInBandReimbursement` (native value + allowlisted
   stable transfers; keep DELEGATECALL/recipient guards).
3. Generic outer pricing + native cost basis + `reimbursed_native >= 3×cost` gate (still gated off).
4. Wire generic route-B submit through the existing native raw-tx path (not submitTempoBundle).
5. Float: native checkBalance branch + continuous native top-up + treasury alert + profit-sweep.
6. Ingress: exempt inBand from priority-fee floor + gas-margin; replace "Deposit to {eoa}" with the
   float-liveness/sponsor path.
7. Mixed-route senders: partition by route in bundle grouping.
8. Stablecoin path: DEX-quote rate module + whitelist sync + $0.01 floor + quote endpoint + stable
   valuation in the gate + stable→native rebalance.
9. Enable `inBandEnabled` per chain: testnet → observe self-heal + gate → mainnet one at a time.
