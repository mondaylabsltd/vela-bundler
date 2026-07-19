use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fmt::{Display, Formatter},
    future::Future,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use alloy::primitives::{Address, B256, Bytes, U256};
use reqwest::Client;
use serde_json::{Value, json};
use tokio::{sync::Mutex, task::JoinSet};
use tokio_util::sync::CancellationToken;

use crate::{
    app::{
        ClaimedDelayedUserOperation, DelayedUserOperation, PreparedBundleIntent,
        PreparedFundingIntent, QueuedUserOperation, StoredUserOperation,
        USER_OPERATION_QUEUE_RETENTION, UserOperationStatusStore,
        rpc::types::{UserOperation, UserOperationStatusKind},
    },
    utils::{
        config::ExecutorConfig,
        market::{binance_usdt_price, is_gnosis_chain},
        rpc as chain_directory, tempo,
        vault::{
            derive_pool_relayer_secret_key, derive_treasury_secret_key, relayer_index_for_sender,
        },
    },
    worker::consumer::{
        MalformedUserOperation, MalformedUserOperationHandlerFuture, RoutedUserOperation,
        UserOperationBatchResults, UserOperationHandler, UserOperationHandlerError,
        UserOperationHandlerFuture,
    },
};

use super::{
    abi::{PackedOperation, get_nonce_calldata, handle_ops_calldata, user_operation_hash},
    cost::{allocate_bundle_gas, native_cost},
    deployment::SimulationContractDeployer,
    receipt::{receipt_succeeded, user_operation_events},
    rpc::{BroadcastOutcome, RpcBatchCall, RpcError, TrustedRpcClient},
    settlement::{
        ChainAssetConfig, SettlementInput, SettlementLog, StablecoinConfig, USD_PRICE_DECIMALS,
        evaluate_batch, parse_reimbursement, verify_stable_transfer_logs,
    },
    simulation::{SimulationResult, SimulationVerdict, simulate_bundle, simulate_individually},
    transaction::{
        TempoTransactionPlan, TransactionPlan, sign_eip1559, sign_tempo, signer_address,
    },
};

const BROADCAST_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const TOP_UP_GAS_LIMIT: u64 = 21_000;
const RECEIPT_RECONCILE_FAILURE_DELAY: Duration = Duration::from_secs(1);
const DELAYED_CLAIM_BATCH_SIZE: usize = 100;
const DELAYED_CLAIM_TTL_MIN: Duration = Duration::from_secs(2 * 60);
const BINANCE_PRICE_TTL: Duration = Duration::from_secs(60);
const USD_PRICE_SCALE: u64 = 100_000_000;
const NATIVE_TOP_UP_USD_CAP: u64 = 20;
const TEMPO_TOP_UP_GAS_BUFFER_BPS: u64 = 12_000;
const ERC20_DECIMALS_SELECTOR: [u8; 4] = [0x31, 0x3c, 0xe5, 0x67];

static LEASE_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(crate) struct ExecutorEngine {
    config: Arc<ExecutorConfig>,
    rpc: TrustedRpcClient,
    store: UserOperationStatusStore,
    relayer_keys: Arc<[k256::SecretKey]>,
    relayer_addresses: Arc<[Address]>,
    treasury_key: Arc<k256::SecretKey>,
    treasury_address: Address,
    simulation_deployer: SimulationContractDeployer,
    directory_chain_assets: Arc<Mutex<HashMap<u64, ResolvedChainAssets>>>,
    market_http: Client,
    market_prices: Arc<Mutex<HashMap<String, CachedMarketPrice>>>,
    broadcast_seen: Arc<Mutex<HashMap<String, Instant>>>,
}

#[derive(Clone)]
struct ResolvedChainAssets {
    assets: ChainAssetConfig,
    native_symbol: String,
}

#[derive(Clone, Debug)]
struct CachedMarketPrice {
    expires_at: Instant,
    price: U256,
}

#[derive(Debug)]
struct Candidate {
    result_index: usize,
    hash: B256,
    hash_string: String,
    entry_point: Address,
    packed: PackedOperation,
    delayed_operation: DelayedUserOperation,
}

#[derive(Clone, Copy, Debug, Default)]
struct BundleReplayAudit {
    active: usize,
    awaiting_submission: usize,
    terminal: usize,
    expired: usize,
}

#[derive(Clone, Debug)]
struct TransactionContext {
    estimated_gas: U256,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
    nonce: u64,
    relayer_balance: U256,
}

#[derive(Clone, Debug)]
struct TempoTransactionContext {
    base_fee_atto: U256,
    nonce: u64,
    relayer_path_usd_balance: U256,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FundingReadiness {
    Ready,
    Pending,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BundleBroadcastDisposition {
    Confirmed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BundleResumeDisposition {
    Confirmed,
    Unknown,
    Cleared,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdmissionAction {
    Execute,
    Recover,
    DeadLetter,
}

#[derive(Debug)]
pub(crate) struct ExecutorBuildError(String);

impl Display for ExecutorBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExecutorBuildError {}

#[derive(Debug)]
struct ExecutorItemError(String);

impl Display for ExecutorItemError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ExecutorItemError {}

impl ExecutorEngine {
    pub(crate) fn new(
        config: ExecutorConfig,
        store: UserOperationStatusStore,
    ) -> Result<Self, ExecutorBuildError> {
        let rpc = TrustedRpcClient::new(&config)
            .map_err(|error| ExecutorBuildError(error.to_string()))?;
        let market_http = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(config.rpc_timeout)
            .build()
            .map_err(|error| {
                ExecutorBuildError(format!("could not create market data client: {error}"))
            })?;
        let mut relayer_keys = Vec::with_capacity(config.pool_width);
        let mut relayer_addresses = Vec::with_capacity(config.pool_width);
        for index in 0..config.pool_width {
            let key = derive_pool_relayer_secret_key(config.operator_secret.expose(), index)
                .map_err(|error| ExecutorBuildError(error.to_string()))?;
            relayer_addresses.push(signer_address(&key));
            relayer_keys.push(key);
        }
        let treasury_key = Arc::new(
            derive_treasury_secret_key(config.operator_secret.expose())
                .map_err(|error| ExecutorBuildError(error.to_string()))?,
        );
        let treasury_address = signer_address(&treasury_key);
        let simulation_deployer = SimulationContractDeployer::new(
            rpc.clone(),
            store.clone(),
            treasury_key.clone(),
            treasury_address,
            config.lease_ttl,
            config.treasury_floor_wei,
        );
        Ok(Self {
            config: Arc::new(config),
            rpc,
            store,
            relayer_keys: relayer_keys.into(),
            relayer_addresses: relayer_addresses.into(),
            treasury_key,
            treasury_address,
            simulation_deployer,
            directory_chain_assets: Arc::new(Mutex::new(HashMap::new())),
            market_http,
            market_prices: Arc::new(Mutex::new(HashMap::new())),
            broadcast_seen: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn treasury_address(&self) -> Address {
        self.treasury_address
    }

    pub(crate) async fn run_reconciler(&self, shutdown: CancellationToken) {
        let mut interval = tokio::time::interval(self.config.receipt_poll_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => return,
                _ = interval.tick() => {
                    let mut failed = false;
                    if let Err(error) = self.reconcile_prepared_bundles().await {
                        failed = true;
                        tracing::warn!(%error, "prepared bundle reconciliation failed");
                    }
                    if let Err(error) = self.reconcile_delayed_user_operations().await {
                        failed = true;
                        tracing::warn!(%error, "delayed UserOperation reconciliation failed");
                    }
                    if failed {
                        tokio::select! {
                            _ = shutdown.cancelled() => return,
                            _ = tokio::time::sleep(RECEIPT_RECONCILE_FAILURE_DELAY) => {}
                        }
                    }
                }
            }
        }
    }

    async fn reconcile_delayed_user_operations(&self) -> Result<(), ExecutorItemError> {
        let token = unique_token("delayed");
        let claims = self
            .store
            .claim_due_user_operations(
                &token,
                DELAYED_CLAIM_BATCH_SIZE,
                self.config.lease_ttl.max(DELAYED_CLAIM_TTL_MIN),
            )
            .await
            .map_err(store_item_error)?;
        if claims.is_empty() {
            return Ok(());
        }

        let mut by_lane = BTreeMap::<(u64, u8), Vec<ClaimedDelayedUserOperation>>::new();
        for claim in claims {
            by_lane
                .entry((claim.operation.chain_id, claim.operation.lane))
                .or_default()
                .push(claim);
        }

        let mut tasks = JoinSet::new();
        for ((chain_id, lane), claims) in by_lane {
            let engine = self.clone();
            let token = token.clone();
            tasks.spawn(async move {
                let result = engine.process_delayed_lane(&token, claims).await;
                (chain_id, lane, result)
            });
        }

        let mut first_error = None;
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((_, _, Ok(()))) => {}
                Ok((chain_id, lane, Err(error))) => {
                    tracing::warn!(chain_id, lane, %error, "delayed lane processing failed");
                    first_error.get_or_insert(error);
                }
                Err(error) => {
                    tracing::error!(?error, "delayed lane task panicked");
                    first_error.get_or_insert_with(|| {
                        ExecutorItemError("delayed lane task panicked".into())
                    });
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn process_delayed_lane(
        &self,
        token: &str,
        claims: Vec<ClaimedDelayedUserOperation>,
    ) -> Result<(), ExecutorItemError> {
        let operations = claims
            .iter()
            .map(|claim| routed_operation_from_delayed(&claim.operation))
            .collect::<Vec<_>>();
        let outcomes = self.handle_lane_batch(operations).await;
        if outcomes.len() != claims.len() {
            return Err(ExecutorItemError(
                "delayed executor returned a misaligned result vector".into(),
            ));
        }

        let mut first_error = None;
        for (claim, outcome) in claims.into_iter().zip(outcomes) {
            let result = match outcome {
                Ok(()) => self
                    .store
                    .complete_delayed_user_operation(&claim.identifier, token)
                    .await
                    .map(|_| ()),
                Err(_) => self
                    .store
                    .retry_delayed_user_operation(
                        &claim.operation,
                        token,
                        self.delayed_payload_ttl(),
                    )
                    .await
                    .map(|_| ()),
            };
            if let Err(error) = result {
                tracing::warn!(
                    chain_id = claim.operation.chain_id,
                    lane = claim.operation.lane,
                    user_operation_hash = %claim.operation.user_operation_hash,
                    %error,
                    "could not finalize delayed UserOperation claim"
                );
                first_error.get_or_insert_with(|| store_item_error(error));
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn handle_lane_batch(
        &self,
        operations: Vec<RoutedUserOperation>,
    ) -> UserOperationBatchResults {
        let mut results = std::iter::repeat_with(|| None)
            .take(operations.len())
            .collect::<Vec<Option<Result<(), UserOperationHandlerError>>>>();
        if operations.is_empty() {
            return Vec::new();
        }
        let chain_id = operations[0].chain_id;
        let lane = operations[0].lane;
        if operations
            .iter()
            .any(|operation| operation.chain_id != chain_id || operation.lane != lane)
        {
            return failure_results(
                operations.len(),
                "consumer returned a mixed chain/lane batch",
            );
        }
        if !self.rpc.supports_chain(chain_id).await {
            tracing::warn!(
                chain_id,
                "Iggy stream discovered without a trusted executor RPC"
            );
            let reason = "chain has no trusted executor RPC";
            self.record_routed_deferred(&operations, None, "rpc", reason)
                .await;
            return failure_results(operations.len(), reason);
        }
        let chain_assets = match if tempo::is_tempo_chain(chain_id) {
            Ok(self.tempo_chain_assets())
        } else {
            self.chain_assets_for(chain_id).await
        } {
            Ok(chain_assets) => chain_assets,
            Err(error) => {
                tracing::warn!(chain_id, %error, "Iggy stream has no usable executor asset policy");
                let reason = error.to_string();
                self.record_routed_deferred(&operations, None, "assets", &reason)
                    .await;
                return failure_results(operations.len(), &reason);
            }
        };

        let hashes = operations
            .iter()
            .map(|operation| operation.user_operation_hash.clone())
            .collect::<Vec<_>>();
        let records = match self.store.get_many(&hashes).await {
            Ok(records) => records,
            Err(error) => return failure_results(operations.len(), &error.to_string()),
        };

        let mut candidates = Vec::new();
        for (index, (routed, record)) in operations.iter().zip(records).enumerate() {
            let mut record = match record {
                Some(record) => record,
                None => {
                    let queued = match queued_operation_from_routed(routed, self.config.pool_width)
                    {
                        Ok(queued) => queued,
                        Err(reason) => {
                            if self.dead_letter_routed(routed, reason).await.is_ok() {
                                results[index] = Some(Ok(()));
                            } else {
                                results[index] =
                                    Some(item_error("could not persist invalid queue message"));
                            }
                            continue;
                        }
                    };
                    if let Err(error) = self.store.restore_queued_from_durable_payload(queued).await
                    {
                        results[index] = Some(item_error(&error.to_string()));
                        continue;
                    }
                    match self.store.get(&routed.user_operation_hash).await {
                        Ok(Some(record)) => {
                            tracing::info!(
                                chain_id,
                                user_operation_hash = %routed.user_operation_hash,
                                "rebuilt expired UserOperation status from durable queue payload"
                            );
                            record
                        }
                        Ok(None) => {
                            results[index] = Some(item_error(
                                "rebuilt UserOperation status disappeared before execution",
                            ));
                            continue;
                        }
                        Err(error) => {
                            results[index] = Some(item_error(&error.to_string()));
                            continue;
                        }
                    }
                }
            };
            if is_durable_status(record.status) {
                results[index] = Some(Ok(()));
                continue;
            }
            match admission_action(record.admitted, queue_record_matches(routed, &record)) {
                AdmissionAction::DeadLetter => {
                    if self
                        .dead_letter_routed(routed, "Iggy envelope does not match Redis admission")
                        .await
                        .is_ok()
                    {
                        results[index] = Some(Ok(()));
                    } else {
                        results[index] =
                            Some(item_error("could not persist mismatched queue message"));
                    }
                    continue;
                }
                AdmissionAction::Recover => {
                    match self.store.mark_admitted(&routed.user_operation_hash).await {
                        Ok(true) => {
                            record.admitted = true;
                            tracing::warn!(
                                chain_id,
                                user_operation_hash = %routed.user_operation_hash,
                                "recovered Redis admission after Iggy producer crash window"
                            );
                        }
                        Ok(false) => {
                            results[index] = Some(item_error(
                                "could not recover expired UserOperation admission",
                            ));
                            continue;
                        }
                        Err(error) => {
                            results[index] = Some(item_error(&error.to_string()));
                            continue;
                        }
                    }
                }
                AdmissionAction::Execute => {}
            }
            match candidate_from_record(index, routed, record, self.config.pool_width) {
                Ok(candidate) => candidates.push(candidate),
                Err(reason) => match self.store.mark_rejected(&routed.user_operation_hash).await {
                    Ok(_) => {
                        tracing::warn!(
                            chain_id,
                            user_operation_hash = %routed.user_operation_hash,
                            reason,
                            "rejected invalid queued UserOperation"
                        );
                        results[index] = Some(Ok(()));
                    }
                    Err(error) => results[index] = Some(item_error(&error.to_string())),
                },
            }
        }
        if candidates.is_empty() {
            return finish_results(results, "no durable executor outcome");
        }

        // Never put two nonces from the same sender into one outer transaction. The later item
        // stays queued and will be retried after the first transaction is reconciled.
        let mut unique_hashes = HashSet::new();
        candidates.retain(|candidate| unique_hashes.insert(candidate.hash));
        let mut senders = HashSet::new();
        candidates.retain(|candidate| {
            senders.insert(candidate.packed.sender) && candidate.result_index < operations.len()
        });
        candidates.truncate(self.config.max_bundle_operations);

        let lease_scope = format!("executor:{chain_id}:{lane}");
        let lease_token = unique_token("lane");
        let acquired = self
            .store
            .acquire_lease(&lease_scope, &lease_token, self.config.lease_ttl)
            .await
            .unwrap_or(false);
        if !acquired {
            self.record_routed_deferred(
                &operations,
                Some(&results),
                "lease",
                "relayer lane is currently owned by another worker",
            )
            .await;
            return finish_results(results, "relayer lane is owned by another worker");
        }

        let outcome = self
            .run_with_lease_heartbeat(
                &lease_scope,
                &lease_token,
                self.execute_with_lane_lease(
                    chain_id,
                    lane,
                    &chain_assets.assets,
                    &chain_assets.native_symbol,
                    candidates,
                    &mut results,
                    &lease_scope,
                    &lease_token,
                ),
            )
            .await;
        if let Err(error) = self.store.release_lease(&lease_scope, &lease_token).await {
            tracing::warn!(chain_id, lane, %error, "could not release relayer lane lease");
        }
        if let Err(error) = outcome {
            let reason = error.to_string();
            self.record_routed_deferred(&operations, Some(&results), "execution", &reason)
                .await;
            tracing::warn!(chain_id, lane, %error, "UserOperation lane execution deferred");
        }

        finish_results(results, "UserOperation execution was deferred")
    }

    /// Persists the concrete retry reason next to the UserOperation. Iggy deliberately retains
    /// the message until this work reaches a durable outcome; without this record, callers can
    /// only see a permanent-looking `queued` state while an executor retry is failing.
    async fn record_routed_deferred(
        &self,
        operations: &[RoutedUserOperation],
        results: Option<&[Option<Result<(), UserOperationHandlerError>>]>,
        stage: &str,
        reason: &str,
    ) {
        for (index, operation) in operations.iter().enumerate() {
            if results.is_some_and(|results| results[index].is_some()) {
                continue;
            }
            self.record_executor_deferred(&operation.user_operation_hash, stage, reason)
                .await;
        }
    }

    async fn record_candidates_deferred(
        &self,
        candidates: &[Candidate],
        stage: &str,
        reason: &str,
    ) {
        for candidate in candidates {
            self.record_executor_deferred(&candidate.hash_string, stage, reason)
                .await;
        }
    }

    async fn record_executor_deferred(&self, user_operation_hash: &str, stage: &str, reason: &str) {
        if let Err(error) = self
            .store
            .record_executor_deferred(user_operation_hash, stage, reason)
            .await
        {
            tracing::warn!(
                user_operation_hash,
                stage,
                %error,
                "could not persist executor retry diagnostic"
            );
        }
    }

    async fn chain_assets_for(
        &self,
        chain_id: u64,
    ) -> Result<ResolvedChainAssets, ExecutorItemError> {
        if let Some(assets) = self
            .directory_chain_assets
            .lock()
            .await
            .get(&chain_id)
            .cloned()
        {
            return Ok(assets);
        }

        let assets = self.directory_usd_stable_assets(chain_id).await?;
        self.directory_chain_assets
            .lock()
            .await
            .insert(chain_id, assets.clone());
        Ok(assets)
    }

    fn tempo_chain_assets(&self) -> ResolvedChainAssets {
        ResolvedChainAssets {
            assets: ChainAssetConfig {
                native_decimals: tempo::PATH_USD_DECIMALS,
                settlement_markup_bps: self.config.settlement_markup_bps,
                stablecoins: BTreeMap::from([(
                    tempo::PATH_USD,
                    StablecoinConfig {
                        symbol: tempo::PATH_USD_SYMBOL.into(),
                        decimals: tempo::PATH_USD_DECIMALS,
                    },
                )]),
            },
            native_symbol: tempo::PATH_USD_SYMBOL.into(),
        }
    }

    async fn directory_usd_stable_assets(
        &self,
        chain_id: u64,
    ) -> Result<ResolvedChainAssets, ExecutorItemError> {
        let metadata = chain_directory::payment_assets(chain_id)
            .await
            .map_err(|_| {
                ExecutorItemError("could not load payment assets from chain directory".into())
            })?;
        let mut stablecoins = metadata
            .stablecoins
            .into_iter()
            .filter_map(|stablecoin| {
                Address::from_str(&stablecoin.contract)
                    .ok()
                    .map(|address| (address, stablecoin.symbol, stablecoin.decimals))
            })
            .collect::<Vec<_>>();
        let missing_decimals = stablecoins
            .iter()
            .enumerate()
            .filter_map(|(index, (address, _, decimals))| {
                decimals.is_none().then_some((index, *address))
            })
            .collect::<Vec<_>>();
        if !missing_decimals.is_empty() {
            let calls = missing_decimals
                .iter()
                .map(|(_, address)| RpcBatchCall {
                    method: "eth_call",
                    params: json!([{
                        "to": address.to_string(),
                        "data": format!("0x{}", hex::encode(ERC20_DECIMALS_SELECTOR)),
                    }, "latest"]),
                })
                .collect::<Vec<_>>();
            let responses = self
                .rpc
                .batch(chain_id, &calls)
                .await
                .map_err(rpc_item_error)?;
            for (response_index, (stable_index, _)) in missing_decimals.into_iter().enumerate() {
                let decimals = response_abi_u256(&responses, response_index, "ERC-20 decimals")
                    .ok()
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|decimals| *decimals <= 38);
                stablecoins[stable_index].2 = decimals;
            }
        }

        let stablecoins = stablecoins
            .into_iter()
            .filter_map(|(address, symbol, decimals)| {
                let decimals = decimals?;
                Some((address, StablecoinConfig { symbol, decimals }))
            })
            .collect::<BTreeMap<_, _>>();
        Ok(ResolvedChainAssets {
            assets: ChainAssetConfig {
                native_decimals: metadata.native.decimals,
                settlement_markup_bps: self.config.settlement_markup_bps,
                stablecoins,
            },
            native_symbol: metadata.native.symbol,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_with_lane_lease(
        &self,
        chain_id: u64,
        lane: u8,
        chain_assets: &ChainAssetConfig,
        native_symbol: &str,
        mut candidates: Vec<Candidate>,
        results: &mut [Option<Result<(), UserOperationHandlerError>>],
        lease_scope: &str,
        lease_token: &str,
    ) -> Result<(), ExecutorItemError> {
        if let Some(intent) = self
            .store
            .get_prepared_bundle_intent(chain_id, lane)
            .await
            .map_err(store_item_error)?
        {
            let disposition = self.resume_bundle_intent(&intent).await?;
            if disposition != BundleResumeDisposition::Unknown {
                for candidate in candidates {
                    if intent
                        .user_operation_hashes
                        .iter()
                        .any(|hash| hash.eq_ignore_ascii_case(&candidate.hash_string))
                    {
                        results[candidate.result_index] = Some(Ok(()));
                    }
                }
            }
            return Ok(());
        }

        let entry_point = candidates[0].entry_point;
        if candidates
            .iter()
            .any(|candidate| candidate.entry_point != entry_point)
        {
            return Err(ExecutorItemError(
                "one lane batch contains multiple EntryPoints".into(),
            ));
        }
        let relayer = self.relayer_addresses[lane as usize];
        let hashes = candidates
            .iter()
            .map(|candidate| candidate.hash)
            .collect::<Vec<_>>();
        let verdicts = simulate_individually(
            &self.rpc,
            chain_id,
            entry_point,
            relayer,
            self.treasury_address,
            &self.simulation_deployer,
            &candidates
                .iter()
                .map(|candidate| &candidate.packed)
                .cloned()
                .collect::<Vec<_>>(),
            &hashes,
        )
        .await;

        let mut survivors = Vec::new();
        let mut nonce_mismatches = Vec::new();
        for (candidate, verdict) in candidates.drain(..).zip(verdicts) {
            match verdict {
                SimulationVerdict::Success(_) => survivors.push(candidate),
                SimulationVerdict::NonceMismatch => nonce_mismatches.push(candidate),
                SimulationVerdict::Rejected(reason) => {
                    self.store
                        .mark_rejected(&candidate.hash_string)
                        .await
                        .map_err(store_item_error)?;
                    tracing::warn!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        reason,
                        "single-operation simulation rejected UserOperation"
                    );
                    results[candidate.result_index] = Some(Ok(()));
                }
                SimulationVerdict::Pending(reason) => {
                    self.record_executor_deferred(
                        &candidate.hash_string,
                        "simulation_deployment",
                        reason,
                    )
                    .await;
                    tracing::info!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        reason,
                        "single-operation simulation is waiting for automatic contract deployment"
                    );
                }
                SimulationVerdict::Transient(reason) => {
                    self.record_executor_deferred(&candidate.hash_string, "simulation", reason)
                        .await;
                    tracing::warn!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        reason,
                        "single-operation simulation unavailable"
                    );
                }
            }
        }
        self.resolve_nonce_mismatches(chain_id, entry_point, nonce_mismatches, results)
            .await;
        if survivors.is_empty() {
            return Ok(());
        }
        self.ensure_lease(lease_scope, lease_token).await?;

        // If a multi-op bundle has a state interaction that does not exist in isolated
        // simulation, fall back to the first op. Later ops stay queued instead of poisoning the
        // whole handleOps transaction.
        let mut bundle_simulation = simulate_bundle(
            &self.rpc,
            chain_id,
            entry_point,
            relayer,
            self.treasury_address,
            &self.simulation_deployer,
            &survivors
                .iter()
                .map(|candidate| &candidate.packed)
                .cloned()
                .collect::<Vec<_>>(),
            &survivors
                .iter()
                .map(|candidate| candidate.hash)
                .collect::<Vec<_>>(),
        )
        .await;
        if matches!(
            bundle_simulation,
            SimulationVerdict::Rejected(_) | SimulationVerdict::NonceMismatch
        ) && survivors.len() > 1
        {
            survivors.truncate(1);
            bundle_simulation = simulate_bundle(
                &self.rpc,
                chain_id,
                entry_point,
                relayer,
                self.treasury_address,
                &self.simulation_deployer,
                &[survivors[0].packed.clone()],
                &[survivors[0].hash],
            )
            .await;
        }
        let bundle_simulation = match bundle_simulation {
            SimulationVerdict::Success(simulation) => simulation,
            SimulationVerdict::Rejected(reason) => {
                self.record_candidates_deferred(&survivors, "bundle_simulation", reason)
                    .await;
                tracing::warn!(
                    chain_id,
                    lane,
                    reason,
                    "final handleOps simulation rejected bundle"
                );
                return Ok(());
            }
            SimulationVerdict::NonceMismatch => {
                self.record_candidates_deferred(
                    &survivors,
                    "bundle_simulation",
                    "final handleOps simulation reported an account nonce mismatch",
                )
                .await;
                tracing::warn!(
                    chain_id,
                    lane,
                    "final handleOps simulation reported an account nonce mismatch"
                );
                return Ok(());
            }
            SimulationVerdict::Pending(reason) => {
                self.record_candidates_deferred(&survivors, "simulation_deployment", reason)
                    .await;
                tracing::info!(
                    chain_id,
                    lane,
                    reason,
                    "final handleOps simulation is waiting for automatic contract deployment"
                );
                return Ok(());
            }
            SimulationVerdict::Transient(reason) => {
                return Err(ExecutorItemError(reason.into()));
            }
        };
        self.ensure_lease(lease_scope, lease_token).await?;

        if tempo::is_tempo_chain(chain_id) {
            return self
                .execute_tempo_bundle(
                    chain_id,
                    lane,
                    entry_point,
                    relayer,
                    survivors,
                    bundle_simulation,
                    results,
                    lease_scope,
                    lease_token,
                )
                .await;
        }

        let calldata = handle_ops_calldata(
            &survivors
                .iter()
                .map(|candidate| candidate.packed.packed.clone())
                .collect::<Vec<_>>(),
            self.treasury_address,
        );
        let context = self
            .transaction_context(chain_id, relayer, entry_point, &calldata)
            .await?;
        let allocations = allocate_bundle_gas(
            bundle_simulation.gas_used,
            context.estimated_gas,
            &bundle_simulation
                .events
                .iter()
                .map(|event| event.actual_gas_used)
                .collect::<Vec<_>>(),
            self.config.gas_buffer_bps,
            self.config.fixed_gas_buffer,
        )
        .ok_or_else(|| ExecutorItemError("bundle gas allocation overflow".into()))?;
        let costs = allocations
            .iter()
            .map(|gas| {
                native_cost(*gas, context.max_fee_per_gas)
                    .ok_or_else(|| ExecutorItemError("bundle native cost overflow".into()))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let settlement = self
            .evaluate_settlement(chain_id, chain_assets, native_symbol, &survivors, &costs)
            .await?;
        // Settlement evidence must come from the exact final handleOps simulation. Individual
        // simulations run against a different pre-state; a prior operation in this bundle can
        // change balances or allowances and make a later transfer disappear. Token address plus
        // indexed sender/treasury topics attributes each ERC-20 payment to its own UserOperation.
        let bundle_logs = bundle_simulation
            .logs
            .iter()
            .map(|log| SettlementLog {
                address: log.address,
                topics: log.topics.clone(),
                data: log.data.clone(),
            })
            .collect::<Vec<_>>();
        let mut rejected_any = false;
        for (candidate, evaluation) in survivors.iter().zip(&settlement.operations) {
            let stable_logs_valid = verify_stable_transfer_logs(
                &evaluation.reimbursement,
                candidate.packed.sender,
                self.treasury_address,
                &bundle_logs,
            );
            if !evaluation.accepted() || !stable_logs_valid {
                self.store
                    .mark_rejected(&candidate.hash_string)
                    .await
                    .map_err(store_item_error)?;
                results[candidate.result_index] = Some(Ok(()));
                rejected_any = true;
                tracing::warn!(
                    chain_id,
                    user_operation_hash = %candidate.hash_string,
                    payment_asset = ?evaluation.payment_asset,
                    paid = %evaluation.paid_amount,
                    required = %evaluation.required_amount,
                    stable_logs_valid,
                    "in-band settlement rejected UserOperation"
                );
            }
        }
        if rejected_any {
            // Reassemble on the next queue delivery so the cost allocation and aggregate estimate
            // never include a rejected payer.
            return Ok(());
        }

        let gas_limit = allocations
            .iter()
            .try_fold(U256::ZERO, |sum, gas| sum.checked_add(*gas))
            .ok_or_else(|| ExecutorItemError("bundle gas limit overflow".into()))?;
        let gas_limit = u64::try_from(gas_limit)
            .map_err(|_| ExecutorItemError("bundle gas limit exceeds uint64".into()))?;
        let prefund = U256::from(gas_limit)
            .checked_mul(U256::from(context.max_fee_per_gas))
            .ok_or_else(|| ExecutorItemError("bundle prefund overflow".into()))?;
        let top_up_max = self
            .native_top_up_cap(chain_id, native_symbol, chain_assets.native_decimals)
            .await;
        if self
            .ensure_relayer_funded(
                chain_id,
                relayer,
                context.relayer_balance,
                prefund,
                context.max_fee_per_gas,
                context.max_priority_fee_per_gas,
                top_up_max,
            )
            .await?
            == FundingReadiness::Pending
        {
            self.record_candidates_deferred(
                &survivors,
                "funding",
                "waiting for relayer funding transaction confirmation",
            )
            .await;
            return Ok(());
        }
        self.ensure_lease(lease_scope, lease_token).await?;

        let signed = sign_eip1559(
            &self.relayer_keys[lane as usize],
            TransactionPlan {
                chain_id,
                nonce: context.nonce,
                gas_limit,
                max_fee_per_gas: context.max_fee_per_gas,
                max_priority_fee_per_gas: context.max_priority_fee_per_gas,
                to: entry_point,
                value: U256::ZERO,
                input: calldata,
            },
        )
        .map_err(|error| ExecutorItemError(error.to_string()))?;
        let intent = PreparedBundleIntent {
            chain_id,
            lane,
            entry_point: entry_point.to_string(),
            raw_transaction: format!("0x{}", hex::encode(&signed.raw_transaction)),
            transaction_hash: signed.transaction_hash.clone(),
            nonce: signed.nonce,
            user_operation_hashes: survivors
                .iter()
                .map(|candidate| candidate.hash_string.clone())
                .collect(),
        };
        self.ensure_lease(lease_scope, lease_token).await?;
        if !self
            .store
            .save_prepared_bundle_intent(&intent)
            .await
            .map_err(store_item_error)?
        {
            let existing = self
                .store
                .get_prepared_bundle_intent(chain_id, lane)
                .await
                .map_err(store_item_error)?
                .ok_or_else(|| ExecutorItemError("prepared bundle raced and disappeared".into()))?;
            self.resume_bundle_intent(&existing).await?;
            return Ok(());
        }
        match self.broadcast_bundle_intent(&intent).await? {
            BundleBroadcastDisposition::Unknown => {
                self.record_candidates_deferred(
                    &survivors,
                    "broadcast",
                    "signed handleOps transaction awaits broadcast confirmation",
                )
                .await;
                return Ok(());
            }
            BundleBroadcastDisposition::Confirmed => {}
        }
        let indexed = self
            .store
            .mark_bundle_submitted(
                chain_id,
                &intent.transaction_hash,
                &intent.user_operation_hashes,
            )
            .await
            .map_err(store_item_error)?;
        if indexed != intent.user_operation_hashes.len() {
            return Err(ExecutorItemError(
                "not every signed UserOperation entered submitted state".into(),
            ));
        }
        for candidate in survivors {
            results[candidate.result_index] = Some(Ok(()));
        }
        tracing::info!(
            chain_id,
            lane,
            relayer = %relayer,
            transaction_hash = %intent.transaction_hash,
            nonce = intent.nonce,
            operations = intent.user_operation_hashes.len(),
            gas_limit,
            "submitted handleOps transaction"
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_tempo_bundle(
        &self,
        chain_id: u64,
        lane: u8,
        entry_point: Address,
        relayer: Address,
        survivors: Vec<Candidate>,
        bundle_simulation: SimulationResult,
        results: &mut [Option<Result<(), UserOperationHandlerError>>],
        lease_scope: &str,
        lease_token: &str,
    ) -> Result<(), ExecutorItemError> {
        // A generic token here would make the treasury's pathUSD float unable to replenish the
        // relayer. Accept the wallet extension only when it agrees with the protocol default;
        // omitted `feeToken` canonically means pathUSD.
        if let Some(candidate) = survivors.iter().find(|candidate| {
            candidate
                .packed
                .fee_token
                .is_some_and(|fee_token| fee_token != tempo::PATH_USD)
        }) {
            self.store
                .mark_rejected(&candidate.hash_string)
                .await
                .map_err(store_item_error)?;
            results[candidate.result_index] = Some(Ok(()));
            tracing::warn!(
                chain_id,
                user_operation_hash = %candidate.hash_string,
                fee_token = ?candidate.packed.fee_token,
                "Tempo UserOperation requested an unsupported fee token"
            );
            return Ok(());
        }

        let calldata = handle_ops_calldata(
            &survivors
                .iter()
                .map(|candidate| candidate.packed.packed.clone())
                .collect::<Vec<_>>(),
            self.treasury_address,
        );
        let context = self.tempo_transaction_context(chain_id, relayer).await?;
        let allocations = allocate_bundle_gas(
            bundle_simulation.gas_used,
            bundle_simulation.gas_used,
            &bundle_simulation
                .events
                .iter()
                .map(|event| event.actual_gas_used)
                .collect::<Vec<_>>(),
            0,
            tempo::TEMPO_COST_BUFFER_GAS,
        )
        .ok_or_else(|| ExecutorItemError("Tempo bundle gas allocation overflow".into()))?;
        let costs = allocations
            .iter()
            .map(|gas| tempo_cost_in_path_usd(*gas, context.base_fee_atto))
            .collect::<Result<Vec<_>, _>>()?;
        let bundle_logs = bundle_simulation
            .logs
            .iter()
            .map(|log| SettlementLog {
                address: log.address,
                topics: log.topics.clone(),
                data: log.data.clone(),
            })
            .collect::<Vec<_>>();
        let mut rejected_any = false;
        let allowlist = BTreeSet::from([tempo::PATH_USD]);
        for (candidate, cost) in survivors.iter().zip(&costs) {
            let reimbursement = parse_reimbursement(
                candidate.packed.call_data.as_ref(),
                self.treasury_address,
                &allowlist,
            );
            let (paid, stable_logs_valid) = match reimbursement {
                Ok(reimbursement) => (
                    reimbursement
                        .stablecoins
                        .get(&tempo::PATH_USD)
                        .copied()
                        .unwrap_or_default(),
                    verify_stable_transfer_logs(
                        &reimbursement,
                        candidate.packed.sender,
                        self.treasury_address,
                        &bundle_logs,
                    ),
                ),
                Err(_) => (U256::ZERO, false),
            };
            let required = marked_tempo_cost(*cost, self.config.settlement_markup_bps)?;
            if paid < required || !stable_logs_valid {
                self.store
                    .mark_rejected(&candidate.hash_string)
                    .await
                    .map_err(store_item_error)?;
                results[candidate.result_index] = Some(Ok(()));
                rejected_any = true;
                tracing::warn!(
                    chain_id,
                    user_operation_hash = %candidate.hash_string,
                    paid = %paid,
                    required = %required,
                    stable_logs_valid,
                    "Tempo pathUSD in-band settlement rejected UserOperation"
                );
            }
        }
        if rejected_any {
            return Ok(());
        }

        let gas_limit = tempo_handle_ops_gas_limit(&survivors)?;
        let outer_max_fee = context
            .base_fee_atto
            .checked_add(context.base_fee_atto / U256::from(2u8))
            .ok_or_else(|| ExecutorItemError("Tempo outer fee overflow".into()))?;
        let outer_max_fee = u128::try_from(outer_max_fee)
            .map_err(|_| ExecutorItemError("Tempo outer fee exceeds uint128".into()))?;
        let required_prefund =
            tempo_cost_in_path_usd(U256::from(gas_limit), U256::from(outer_max_fee))?;
        if self
            .ensure_tempo_relayer_funded(
                chain_id,
                relayer,
                context.relayer_path_usd_balance,
                required_prefund,
                outer_max_fee,
            )
            .await?
            == FundingReadiness::Pending
        {
            self.record_candidates_deferred(
                &survivors,
                "funding",
                "waiting for relayer pathUSD funding transaction confirmation",
            )
            .await;
            return Ok(());
        }
        self.ensure_lease(lease_scope, lease_token).await?;

        let signed = sign_tempo(
            &self.relayer_keys[lane as usize],
            TempoTransactionPlan {
                chain_id,
                nonce: context.nonce,
                gas_limit,
                max_fee_per_gas: outer_max_fee,
                max_priority_fee_per_gas: 0,
                fee_token: tempo::PATH_USD,
                to: entry_point,
                input: calldata,
            },
        )
        .map_err(|error| ExecutorItemError(error.to_string()))?;
        let intent = PreparedBundleIntent {
            chain_id,
            lane,
            entry_point: entry_point.to_string(),
            raw_transaction: format!("0x{}", hex::encode(&signed.raw_transaction)),
            transaction_hash: signed.transaction_hash.clone(),
            nonce: signed.nonce,
            user_operation_hashes: survivors
                .iter()
                .map(|candidate| candidate.hash_string.clone())
                .collect(),
        };
        self.ensure_lease(lease_scope, lease_token).await?;
        if !self
            .store
            .save_prepared_bundle_intent(&intent)
            .await
            .map_err(store_item_error)?
        {
            let existing = self
                .store
                .get_prepared_bundle_intent(chain_id, lane)
                .await
                .map_err(store_item_error)?
                .ok_or_else(|| {
                    ExecutorItemError("prepared Tempo bundle raced and disappeared".into())
                })?;
            self.resume_bundle_intent(&existing).await?;
            return Ok(());
        }
        if self.broadcast_bundle_intent(&intent).await? == BundleBroadcastDisposition::Unknown {
            self.record_candidates_deferred(
                &survivors,
                "broadcast",
                "signed Tempo handleOps transaction awaits broadcast confirmation",
            )
            .await;
            return Ok(());
        }
        let indexed = self
            .store
            .mark_bundle_submitted(
                chain_id,
                &intent.transaction_hash,
                &intent.user_operation_hashes,
            )
            .await
            .map_err(store_item_error)?;
        if indexed != intent.user_operation_hashes.len() {
            return Err(ExecutorItemError(
                "not every signed Tempo UserOperation entered submitted state".into(),
            ));
        }
        for candidate in survivors {
            results[candidate.result_index] = Some(Ok(()));
        }
        tracing::info!(
            chain_id,
            lane,
            relayer = %relayer,
            transaction_hash = %intent.transaction_hash,
            nonce = intent.nonce,
            operations = intent.user_operation_hashes.len(),
            gas_limit,
            fee_token = %tempo::PATH_USD,
            "submitted Tempo 0x76 handleOps transaction"
        );
        Ok(())
    }

    async fn tempo_transaction_context(
        &self,
        chain_id: u64,
        relayer: Address,
    ) -> Result<TempoTransactionContext, ExecutorItemError> {
        let calls = [
            RpcBatchCall {
                method: "eth_getBlockByNumber",
                params: json!(["latest", false]),
            },
            RpcBatchCall {
                method: "eth_gasPrice",
                params: json!([]),
            },
            RpcBatchCall {
                method: "eth_getTransactionCount",
                params: json!([relayer.to_string(), "pending"]),
            },
            RpcBatchCall {
                method: "eth_call",
                params: json!([{
                    "to": tempo::PATH_USD.to_string(),
                    "data": format!("0x{}", hex::encode(tempo::path_usd_balance_calldata(relayer))),
                }, "latest"]),
            },
        ];
        let responses = self
            .rpc
            .batch(chain_id, &calls)
            .await
            .map_err(rpc_item_error)?;
        let base_fee_atto = response_value(&responses, 0, "Tempo latest block")?
            .get("baseFeePerGas")
            .and_then(Value::as_str)
            .and_then(parse_quantity)
            .or_else(|| response_quantity_optional(&responses, 1))
            .unwrap_or_else(|| U256::from(tempo::TEMPO_BASE_FEE_ATTO));
        let nonce = u64::try_from(response_quantity(&responses, 2, "Tempo relayer nonce")?)
            .map_err(|_| ExecutorItemError("Tempo relayer nonce exceeds uint64".into()))?;
        let relayer_path_usd_balance = response_abi_u256(&responses, 3, "Tempo pathUSD balance")?;
        Ok(TempoTransactionContext {
            base_fee_atto,
            nonce,
            relayer_path_usd_balance,
        })
    }

    /// Distinguishes a future keyed nonce (retry later) from a stale nonce (durably reject).
    /// This is called only for explicit AA25/invalid-account-nonce simulation failures, keeping
    /// the common path free of extra chain reads.
    async fn resolve_nonce_mismatches(
        &self,
        chain_id: u64,
        entry_point: Address,
        candidates: Vec<Candidate>,
        results: &mut [Option<Result<(), UserOperationHandlerError>>],
    ) {
        if candidates.is_empty() {
            return;
        }
        let calls = candidates
            .iter()
            .map(|candidate| RpcBatchCall {
                method: "eth_call",
                params: json!([{
                    "to": entry_point.to_string(),
                    "data": format!(
                        "0x{}",
                        hex::encode(get_nonce_calldata(
                            candidate.packed.sender,
                            candidate.packed.packed.nonce,
                        ))
                    ),
                }, "latest"]),
            })
            .collect::<Vec<_>>();
        let responses = match self.rpc.batch(chain_id, &calls).await {
            Ok(responses) => responses,
            Err(error) => {
                tracing::warn!(
                    chain_id,
                    count = candidates.len(),
                    %error,
                    "could not resolve account nonce mismatches"
                );
                for candidate in candidates {
                    results[candidate.result_index] = Some(item_error(
                        "account nonce lookup is temporarily unavailable",
                    ));
                }
                return;
            }
        };

        for (index, candidate) in candidates.into_iter().enumerate() {
            let onchain_nonce = match response_abi_u256(&responses, index, "EntryPoint getNonce") {
                Ok(nonce) => nonce,
                Err(error) => {
                    tracing::warn!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        %error,
                        "could not decode EntryPoint account nonce"
                    );
                    results[candidate.result_index] = Some(item_error(
                        "account nonce lookup is temporarily unavailable",
                    ));
                    continue;
                }
            };
            let user_nonce = candidate.packed.packed.nonce;
            if user_nonce > onchain_nonce {
                match self
                    .store
                    .defer_user_operation(&candidate.delayed_operation, self.delayed_payload_ttl())
                    .await
                {
                    Ok(attempt) => {
                        tracing::info!(
                            chain_id,
                            user_operation_hash = %candidate.hash_string,
                            user_nonce = %user_nonce,
                            onchain_nonce = %onchain_nonce,
                            attempt,
                            "future account nonce moved to durable delayed inbox"
                        );
                        // Redis now owns a complete immutable copy. A successful item result lets
                        // Iggy advance past this nonce without losing at-least-once execution.
                        results[candidate.result_index] = Some(Ok(()));
                    }
                    Err(error) => {
                        tracing::warn!(
                            chain_id,
                            user_operation_hash = %candidate.hash_string,
                            %error,
                            "could not persist future nonce in delayed inbox"
                        );
                        results[candidate.result_index] =
                            Some(item_error("could not persist future UserOperation"));
                    }
                }
                continue;
            }

            match self.store.mark_rejected(&candidate.hash_string).await {
                Ok(_) => {
                    tracing::warn!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        user_nonce = %user_nonce,
                        onchain_nonce = %onchain_nonce,
                        "stale account nonce rejected UserOperation"
                    );
                    results[candidate.result_index] = Some(Ok(()));
                }
                Err(error) => {
                    tracing::warn!(
                        chain_id,
                        user_operation_hash = %candidate.hash_string,
                        %error,
                        "could not persist stale nonce rejection"
                    );
                    results[candidate.result_index] =
                        Some(item_error("could not persist stale nonce rejection"));
                }
            }
        }
    }

    fn delayed_payload_ttl(&self) -> Duration {
        self.config.attempt_ttl.max(USER_OPERATION_QUEUE_RETENTION)
    }

    async fn ensure_lease(&self, scope: &str, token: &str) -> Result<(), ExecutorItemError> {
        match self
            .store
            .renew_lease(scope, token, self.config.lease_ttl)
            .await
        {
            Ok(true) => Ok(()),
            Ok(false) => Err(ExecutorItemError("executor lease was lost".into())),
            Err(error) => Err(store_item_error(error)),
        }
    }

    async fn run_with_lease_heartbeat<T, F>(
        &self,
        scope: &str,
        token: &str,
        future: F,
    ) -> Result<T, ExecutorItemError>
    where
        F: Future<Output = Result<T, ExecutorItemError>>,
    {
        let period = (self.config.lease_ttl / 3).max(Duration::from_millis(1));
        let start = tokio::time::Instant::now() + period;
        let mut heartbeat = tokio::time::interval_at(start, period);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        tokio::pin!(future);

        loop {
            tokio::select! {
                biased;
                _ = heartbeat.tick() => {
                    self.ensure_lease(scope, token).await?;
                }
                result = &mut future => return result,
            }
        }
    }

    async fn dead_letter_routed(
        &self,
        operation: &RoutedUserOperation,
        reason: &str,
    ) -> Result<(), ExecutorItemError> {
        let payload = serde_json::to_vec(&json!({
            "schemaVersion": operation.schema_version,
            "userOperationHash": operation.user_operation_hash,
            "chainId": operation.chain_id,
            "entryPoint": operation.entry_point,
            "userOperation": operation.user_operation,
        }))
        .map_err(|_| ExecutorItemError("could not serialize dead-letter payload".into()))?;
        self.store
            .save_malformed_dead_letter(
                operation.chain_id,
                operation.partition_id,
                operation.offset,
                &payload,
                reason,
                Some(&operation.user_operation_hash),
                self.config.attempt_ttl,
            )
            .await
            .map_err(store_item_error)?;
        Ok(())
    }

    async fn transaction_context(
        &self,
        chain_id: u64,
        relayer: Address,
        entry_point: Address,
        calldata: &Bytes,
    ) -> Result<TransactionContext, ExecutorItemError> {
        let transaction = json!({
            "from": relayer.to_string(),
            "to": entry_point.to_string(),
            "data": format!("0x{}", hex::encode(calldata)),
        });
        let calls = [
            RpcBatchCall {
                method: "eth_estimateGas",
                params: json!([transaction]),
            },
            RpcBatchCall {
                method: "eth_getBlockByNumber",
                params: json!(["latest", false]),
            },
            RpcBatchCall {
                method: "eth_maxPriorityFeePerGas",
                params: json!([]),
            },
            RpcBatchCall {
                method: "eth_getTransactionCount",
                params: json!([relayer.to_string(), "pending"]),
            },
            RpcBatchCall {
                method: "eth_getBalance",
                params: json!([relayer.to_string(), "pending"]),
            },
        ];
        let responses = self
            .rpc
            .batch(chain_id, &calls)
            .await
            .map_err(rpc_item_error)?;
        let estimated_gas = response_quantity(&responses, 0, "eth_estimateGas")?;
        let block = response_value(&responses, 1, "eth_getBlockByNumber")?;
        let base_fee = block
            .get("baseFeePerGas")
            .and_then(Value::as_str)
            .and_then(parse_quantity)
            .ok_or_else(|| ExecutorItemError("latest block has no EIP-1559 base fee".into()))?;
        let tip = match response_quantity_optional(&responses, 2) {
            Some(tip) => tip,
            None => {
                let gas_price = self
                    .rpc
                    .call(chain_id, "eth_gasPrice", json!([]))
                    .await
                    .map_err(rpc_item_error)?
                    .as_str()
                    .and_then(parse_quantity)
                    .ok_or_else(|| {
                        ExecutorItemError("eth_gasPrice returned an invalid quantity".into())
                    })?;
                gas_price.checked_sub(base_fee).ok_or_else(|| {
                    ExecutorItemError("gas price is below the latest base fee".into())
                })?
            }
        };
        let base_fee = u128::try_from(base_fee)
            .map_err(|_| ExecutorItemError("base fee exceeds uint128".into()))?;
        let tip = u128::try_from(tip)
            .map_err(|_| ExecutorItemError("priority fee exceeds uint128".into()))?;
        let max_fee_per_gas = base_fee
            .checked_mul(2)
            .and_then(|fee| fee.checked_add(tip))
            .ok_or_else(|| ExecutorItemError("EIP-1559 fee overflow".into()))?;
        let nonce = u64::try_from(response_quantity(&responses, 3, "eth_getTransactionCount")?)
            .map_err(|_| ExecutorItemError("relayer nonce exceeds uint64".into()))?;
        let relayer_balance = response_quantity(&responses, 4, "eth_getBalance")?;

        Ok(TransactionContext {
            estimated_gas,
            max_fee_per_gas,
            max_priority_fee_per_gas: tip,
            nonce,
            relayer_balance,
        })
    }

    async fn evaluate_settlement(
        &self,
        chain_id: u64,
        chain_assets: &ChainAssetConfig,
        native_symbol: &str,
        candidates: &[Candidate],
        costs: &[U256],
    ) -> Result<super::settlement::BatchSettlementEvaluation, ExecutorItemError> {
        let inputs = candidates
            .iter()
            .zip(costs)
            .map(|(candidate, cost)| SettlementInput {
                call_data: candidate.packed.call_data.as_ref(),
                gas_native_cost: *cost,
            })
            .collect::<Vec<_>>();
        let native_usd_price =
            if has_stablecoin_payment(self.treasury_address, chain_assets, &inputs) {
                Some(self.market_usd_price(chain_id, native_symbol).await?)
            } else {
                None
            };
        evaluate_batch(
            self.treasury_address,
            chain_assets,
            &inputs,
            native_usd_price,
        )
        .map_err(|error| ExecutorItemError(error.to_string()))
    }

    async fn market_usd_price(
        &self,
        chain_id: u64,
        symbol: &str,
    ) -> Result<U256, ExecutorItemError> {
        // xDAI is the native Gnosis gas asset and is defined to be USD-pegged. This also keeps
        // Gnosis stablecoin settlement and relayer funding independent of Binance availability.
        if is_gnosis_chain(chain_id) {
            return Ok(U256::from(USD_PRICE_SCALE));
        }
        let symbol = symbol.trim().to_ascii_uppercase();
        if symbol.is_empty() || !symbol.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err(ExecutorItemError(
                "native currency symbol is invalid".into(),
            ));
        }
        let now = Instant::now();
        if let Some(cached) = self.market_prices.lock().await.get(&symbol).cloned()
            && cached.expires_at > now
        {
            return Ok(cached.price);
        }
        let raw_price = binance_usdt_price(&self.market_http, &symbol)
            .await
            .ok_or_else(|| ExecutorItemError("Binance native USD price request failed".into()))?;
        let price = parse_market_usd_price(&raw_price)
            .ok_or_else(|| ExecutorItemError("Binance native USD price is invalid".into()))?;
        self.market_prices.lock().await.insert(
            symbol,
            CachedMarketPrice {
                expires_at: now + BINANCE_PRICE_TTL,
                price,
            },
        );
        Ok(price)
    }

    /// Cap one native-token relayer top-up at 20 USD when Binance has a fresh quote. A network
    /// with no usable market price intentionally keeps the operator's static wei-denominated
    /// safety cap instead of blocking execution on the price service.
    async fn native_top_up_cap(
        &self,
        chain_id: u64,
        native_symbol: &str,
        native_decimals: u32,
    ) -> U256 {
        let fallback = U256::from(self.config.top_up_max_wei);
        let Ok(price) = self.market_usd_price(chain_id, native_symbol).await else {
            return fallback;
        };
        let Some(cap) = native_amount_for_usd_cap(native_decimals, price, NATIVE_TOP_UP_USD_CAP)
        else {
            tracing::warn!(
                native_symbol,
                native_decimals,
                "could not convert USD relayer top-up cap to native units; using static cap"
            );
            return fallback;
        };
        tracing::debug!(
            native_symbol,
            native_decimals,
            native_units = %cap,
            "using USD-denominated relayer top-up cap"
        );
        cap
    }

    async fn resume_bundle_intent(
        &self,
        intent: &PreparedBundleIntent,
    ) -> Result<BundleResumeDisposition, ExecutorItemError> {
        let audit = self.audit_bundle_replay(intent).await?;
        if audit.active == 0 && audit.terminal != 0 {
            self.clear_obsolete_bundle_intent(intent, audit).await?;
            return Ok(BundleResumeDisposition::Cleared);
        }
        if audit.terminal != 0 || audit.expired != 0 {
            tracing::warn!(
                chain_id = intent.chain_id,
                lane = intent.lane,
                transaction_hash = %intent.transaction_hash,
                active_members = audit.active,
                terminal_members = audit.terminal,
                expired_members = audit.expired,
                "replaying prepared bundle after auditing unavailable members"
            );
        }
        match self.broadcast_bundle_intent(intent).await? {
            BundleBroadcastDisposition::Unknown => {
                return Ok(BundleResumeDisposition::Unknown);
            }
            BundleBroadcastDisposition::Confirmed => {}
        }
        if audit.active == 0 {
            // Lifecycle records expire sooner than the signed outbox. Without a terminal record
            // or receipt there is no proof that this transaction is safe to forget, so retain it
            // and keep reconciling the relayer nonce.
            return Ok(BundleResumeDisposition::Confirmed);
        }
        let indexed = self
            .store
            .mark_bundle_submitted(
                intent.chain_id,
                &intent.transaction_hash,
                &intent.user_operation_hashes,
            )
            .await
            .map_err(store_item_error)?;
        if indexed != audit.active {
            // Records retain a shorter TTL than prepared outbox entries. A member can expire or
            // reach a terminal state between the preflight audit and this atomic transition.
            // Re-audit before deciding that the lane is corrupt; exact submitted membership is
            // also safe when an earlier recovery attempt already completed the transition.
            let after = self.audit_bundle_replay(intent).await?;
            if after.active == 0 {
                if after.terminal != 0 {
                    self.clear_obsolete_bundle_intent(intent, after).await?;
                    return Ok(BundleResumeDisposition::Cleared);
                }
                return Ok(BundleResumeDisposition::Confirmed);
            }
            if after.awaiting_submission != 0 {
                return Err(ExecutorItemError(
                    "prepared bundle has live members that could not enter submitted state".into(),
                ));
            }
        }
        Ok(BundleResumeDisposition::Confirmed)
    }

    async fn audit_bundle_replay(
        &self,
        intent: &PreparedBundleIntent,
    ) -> Result<BundleReplayAudit, ExecutorItemError> {
        let records = self
            .store
            .get_many(&intent.user_operation_hashes)
            .await
            .map_err(store_item_error)?;
        if records.len() != intent.user_operation_hashes.len() {
            return Err(ExecutorItemError(
                "Redis returned incomplete prepared bundle membership".into(),
            ));
        }

        let mut audit = BundleReplayAudit::default();
        for (hash, record) in intent.user_operation_hashes.iter().zip(records) {
            let Some(record) = record else {
                audit.expired += 1;
                continue;
            };
            if record.chain_id != intent.chain_id
                || !record.entry_point.eq_ignore_ascii_case(&intent.entry_point)
            {
                return Err(ExecutorItemError(format!(
                    "prepared bundle member {hash} no longer matches its chain and EntryPoint"
                )));
            }

            match record.status {
                UserOperationStatusKind::Queued | UserOperationStatusKind::NotSubmitted => {
                    if !record.admitted {
                        return Err(ExecutorItemError(format!(
                            "prepared bundle member {hash} is no longer admitted"
                        )));
                    }
                    audit.active += 1;
                    audit.awaiting_submission += 1;
                }
                UserOperationStatusKind::Submitted => {
                    if !record
                        .transaction_hash
                        .as_ref()
                        .is_some_and(|transaction_hash| {
                            transaction_hash.eq_ignore_ascii_case(&intent.transaction_hash)
                        })
                    {
                        return Err(ExecutorItemError(format!(
                            "prepared bundle member {hash} belongs to another transaction"
                        )));
                    }
                    audit.active += 1;
                }
                UserOperationStatusKind::Rejected
                | UserOperationStatusKind::Included
                | UserOperationStatusKind::Failed => audit.terminal += 1,
                UserOperationStatusKind::NotFound => {
                    return Err(ExecutorItemError(format!(
                        "prepared bundle member {hash} has an invalid stored status"
                    )));
                }
            }
        }
        Ok(audit)
    }

    async fn clear_obsolete_bundle_intent(
        &self,
        intent: &PreparedBundleIntent,
        audit: BundleReplayAudit,
    ) -> Result<(), ExecutorItemError> {
        if audit.terminal == 0 {
            return Err(ExecutorItemError(
                "refusing to clear an unproven prepared bundle".into(),
            ));
        }
        self.store
            .clear_prepared_bundle_intent(intent.chain_id, intent.lane, &intent.transaction_hash)
            .await
            .map_err(store_item_error)?;
        self.broadcast_seen
            .lock()
            .await
            .remove(&intent.transaction_hash);
        tracing::warn!(
            chain_id = intent.chain_id,
            lane = intent.lane,
            transaction_hash = %intent.transaction_hash,
            terminal_members = audit.terminal,
            expired_members = audit.expired,
            "cleared prepared bundle with no live lifecycle members"
        );
        Ok(())
    }

    /// Broadcasts the exact durable bytes. An ambiguous send is not mempool admission: the
    /// expected transaction hash must be observable before callers may persist `submitted`.
    async fn broadcast_bundle_intent(
        &self,
        intent: &PreparedBundleIntent,
    ) -> Result<BundleBroadcastDisposition, ExecutorItemError> {
        let raw = validate_raw_transaction(&intent.raw_transaction, &intent.transaction_hash)?;
        if self
            .recently_confirmed_broadcast(&intent.transaction_hash)
            .await
        {
            return Ok(BundleBroadcastDisposition::Confirmed);
        }
        let outcome = match self
            .rpc
            .broadcast_raw_transaction(intent.chain_id, &raw)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                return Err(rpc_item_error(error));
            }
        };
        match outcome {
            BroadcastOutcome::Accepted(hash)
                if hash.eq_ignore_ascii_case(&intent.transaction_hash) =>
            {
                self.remember_confirmed_broadcast(&intent.transaction_hash)
                    .await;
                Ok(BundleBroadcastDisposition::Confirmed)
            }
            BroadcastOutcome::Accepted(_) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                Err(ExecutorItemError(
                    "RPC returned a transaction hash different from the signed bytes".into(),
                ))
            }
            BroadcastOutcome::Ambiguous(reason) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                if self
                    .transaction_is_known(intent.chain_id, &intent.transaction_hash)
                    .await
                {
                    self.remember_confirmed_broadcast(&intent.transaction_hash)
                        .await;
                    Ok(BundleBroadcastDisposition::Confirmed)
                } else if nonce_too_low(&reason) && self.bundle_nonce_is_stale(intent).await {
                    self.clear_stale_bundle_intent(intent, &reason).await?;
                    Ok(BundleBroadcastDisposition::Unknown)
                } else {
                    tracing::warn!(
                        chain_id = intent.chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        reason,
                        "ambiguous handleOps broadcast is not yet observable"
                    );
                    Ok(BundleBroadcastDisposition::Unknown)
                }
            }
            BroadcastOutcome::Rejected(reason) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                if self
                    .transaction_is_known(intent.chain_id, &intent.transaction_hash)
                    .await
                {
                    self.remember_confirmed_broadcast(&intent.transaction_hash)
                        .await;
                    return Ok(BundleBroadcastDisposition::Confirmed);
                }
                if nonce_too_low(&reason) && self.bundle_nonce_is_stale(intent).await {
                    self.clear_stale_bundle_intent(intent, &reason).await?;
                    return Ok(BundleBroadcastDisposition::Unknown);
                }
                tracing::warn!(
                    chain_id = intent.chain_id,
                    lane = intent.lane,
                    transaction_hash = %intent.transaction_hash,
                    reason,
                    "rejected broadcast is unproven; retaining exact handleOps outbox"
                );
                Ok(BundleBroadcastDisposition::Unknown)
            }
        }
    }

    async fn transaction_is_known(&self, chain_id: u64, expected_hash: &str) -> bool {
        match self
            .rpc
            .call(chain_id, "eth_getTransactionByHash", json!([expected_hash]))
            .await
        {
            Ok(Value::Object(transaction)) => transaction
                .get("hash")
                .and_then(Value::as_str)
                .is_some_and(|hash| hash.eq_ignore_ascii_case(expected_hash)),
            Ok(_) => false,
            Err(error) => {
                tracing::warn!(
                    chain_id,
                    transaction_hash = expected_hash,
                    %error,
                    "could not confirm ambiguous transaction broadcast"
                );
                false
            }
        }
    }

    /// A nonce error alone is not sufficient to discard an exact outbox: it could merely be a
    /// pending transaction observed by a different node. Only a higher *latest* nonce proves the
    /// signed bytes can never be included, so clearing then lets queued UserOperations rebuild
    /// against the next nonce without risking a duplicate handleOps submission.
    async fn bundle_nonce_is_stale(&self, intent: &PreparedBundleIntent) -> bool {
        let Some(relayer) = self.relayer_addresses.get(intent.lane as usize) else {
            return false;
        };
        match self
            .rpc
            .call(
                intent.chain_id,
                "eth_getTransactionCount",
                json!([relayer.to_string(), "latest"]),
            )
            .await
            .ok()
            .and_then(|value| value.as_str().and_then(parse_quantity))
            .and_then(|nonce| u64::try_from(nonce).ok())
        {
            Some(latest_nonce) => latest_nonce > intent.nonce,
            None => false,
        }
    }

    async fn clear_stale_bundle_intent(
        &self,
        intent: &PreparedBundleIntent,
        reason: &str,
    ) -> Result<(), ExecutorItemError> {
        let cleared = self
            .store
            .clear_prepared_bundle_intent(intent.chain_id, intent.lane, &intent.transaction_hash)
            .await
            .map_err(store_item_error)?;
        // The consumer and the recovery loop can observe the same intent concurrently. Only the
        // caller that atomically removed it should emit the recovery log and clear its local
        // broadcast cache.
        if !cleared {
            return Ok(());
        }
        self.broadcast_seen
            .lock()
            .await
            .remove(&intent.transaction_hash);
        tracing::warn!(
            chain_id = intent.chain_id,
            lane = intent.lane,
            relayer = %self.relayer_addresses[intent.lane as usize],
            stale_nonce = intent.nonce,
            transaction_hash = %intent.transaction_hash,
            reason,
            "discarded a prepared handleOps transaction whose nonce is already mined; queued operations will be rebuilt"
        );
        Ok(())
    }

    async fn recently_confirmed_broadcast(&self, transaction_hash: &str) -> bool {
        let now = Instant::now();
        let mut confirmed = self.broadcast_seen.lock().await;
        confirmed.retain(|_, at| now.saturating_duration_since(*at) < BROADCAST_RETRY_INTERVAL);
        confirmed.contains_key(transaction_hash)
    }

    async fn remember_confirmed_broadcast(&self, transaction_hash: &str) {
        self.broadcast_seen
            .lock()
            .await
            .insert(transaction_hash.to_owned(), Instant::now());
    }

    async fn reconcile_prepared_bundles(&self) -> Result<(), ExecutorItemError> {
        let intents = self
            .store
            .list_prepared_bundle_intents()
            .await
            .map_err(store_item_error)?;
        let mut claimed_by_chain = BTreeMap::<u64, Vec<PreparedBundleIntent>>::new();
        for intent in intents {
            let disposition = match self.resume_bundle_intent(&intent).await {
                Ok(disposition) => disposition,
                Err(error) => {
                    tracing::warn!(
                        chain_id = intent.chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        %error,
                        "could not resume prepared bundle"
                    );
                    continue;
                }
            };
            if disposition != BundleResumeDisposition::Confirmed {
                continue;
            }
            let still_exists = match self
                .store
                .get_prepared_bundle_intent(intent.chain_id, intent.lane)
                .await
            {
                Ok(intent) => intent.is_some(),
                Err(error) => {
                    tracing::warn!(
                        chain_id = intent.chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        %error,
                        "could not reload prepared bundle"
                    );
                    continue;
                }
            };
            if !still_exists {
                continue;
            }
            let claimed = match self
                .store
                .acquire_lease(
                    &format!("receipt:{}:{}", intent.chain_id, intent.transaction_hash),
                    &unique_token("receipt"),
                    self.config.receipt_poll_interval,
                )
                .await
            {
                Ok(claimed) => claimed,
                Err(error) => {
                    tracing::warn!(
                        chain_id = intent.chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        %error,
                        "could not claim prepared bundle receipt check"
                    );
                    continue;
                }
            };
            if claimed {
                claimed_by_chain
                    .entry(intent.chain_id)
                    .or_default()
                    .push(intent);
            }
        }

        for (chain_id, intents) in claimed_by_chain {
            let calls = intents
                .iter()
                .map(|intent| RpcBatchCall {
                    method: "eth_getTransactionReceipt",
                    params: json!([intent.transaction_hash]),
                })
                .collect::<Vec<_>>();
            let receipts = match self.rpc.batch(chain_id, &calls).await {
                Ok(receipts) => receipts,
                Err(error) => {
                    tracing::warn!(chain_id, %error, "bundle receipt batch RPC failed");
                    continue;
                }
            };
            for (intent, receipt) in intents.into_iter().zip(receipts) {
                let receipt = match receipt {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        tracing::warn!(
                            chain_id,
                            lane = intent.lane,
                            transaction_hash = %intent.transaction_hash,
                            %error,
                            "bundle receipt item RPC failed"
                        );
                        continue;
                    }
                };
                if receipt.is_null() {
                    continue;
                }
                let persisted = match receipt_succeeded(&receipt) {
                    Some(false) => {
                        self.store
                            .mark_bundle_failed(chain_id, &intent.transaction_hash, receipt.clone())
                            .await
                    }
                    Some(true) => {
                        let entry_point = match Address::from_str(&intent.entry_point) {
                            Ok(entry_point) => entry_point,
                            Err(_) => {
                                tracing::warn!(
                                    chain_id,
                                    lane = intent.lane,
                                    transaction_hash = %intent.transaction_hash,
                                    "prepared bundle EntryPoint is invalid"
                                );
                                continue;
                            }
                        };
                        let events = user_operation_events(
                            &receipt,
                            entry_point,
                            &intent.user_operation_hashes,
                        );
                        self.store
                            .mark_bundle_confirmed(
                                chain_id,
                                &intent.transaction_hash,
                                receipt,
                                &events,
                            )
                            .await
                    }
                    None => {
                        tracing::warn!(
                            chain_id,
                            lane = intent.lane,
                            transaction_hash = %intent.transaction_hash,
                            "bundle receipt has an invalid status"
                        );
                        continue;
                    }
                };
                if let Err(error) = persisted {
                    tracing::warn!(
                        chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        %error,
                        "could not persist reconciled bundle receipt"
                    );
                    continue;
                }
                if let Err(error) = self
                    .store
                    .clear_prepared_bundle_intent(chain_id, intent.lane, &intent.transaction_hash)
                    .await
                {
                    tracing::warn!(
                        chain_id,
                        lane = intent.lane,
                        transaction_hash = %intent.transaction_hash,
                        %error,
                        "could not clear reconciled prepared bundle"
                    );
                    continue;
                }
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                tracing::info!(
                    chain_id,
                    lane = intent.lane,
                    transaction_hash = %intent.transaction_hash,
                    "reconciled handleOps transaction receipt"
                );
            }
        }
        Ok(())
    }

    async fn ensure_tempo_relayer_funded(
        &self,
        chain_id: u64,
        relayer: Address,
        relayer_balance: U256,
        required_prefund: U256,
        max_fee_per_gas: u128,
    ) -> Result<FundingReadiness, ExecutorItemError> {
        let minimum = required_prefund.max(U256::from(tempo::TEMPO_FLOAT_MIN));
        if relayer_balance >= minimum {
            return Ok(FundingReadiness::Ready);
        }

        let scope = format!("treasury:{chain_id}");
        let token = unique_token("tempo-treasury");
        if !self
            .store
            .acquire_lease(&scope, &token, self.config.lease_ttl)
            .await
            .map_err(store_item_error)?
        {
            return Ok(FundingReadiness::Pending);
        }
        let result = self
            .run_with_lease_heartbeat(
                &scope,
                &token,
                self.ensure_tempo_relayer_funded_locked(
                    chain_id,
                    relayer,
                    relayer_balance,
                    required_prefund,
                    max_fee_per_gas,
                    &scope,
                    &token,
                ),
            )
            .await;
        if let Err(error) = self.store.release_lease(&scope, &token).await {
            tracing::warn!(chain_id, %error, "could not release Tempo treasury nonce lease");
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn ensure_tempo_relayer_funded_locked(
        &self,
        chain_id: u64,
        relayer: Address,
        relayer_balance: U256,
        required_prefund: U256,
        max_fee_per_gas: u128,
        lease_scope: &str,
        lease_token: &str,
    ) -> Result<FundingReadiness, ExecutorItemError> {
        if let Some(intent) = self
            .store
            .get_prepared_funding_intent(chain_id)
            .await
            .map_err(store_item_error)?
        {
            self.resume_funding_intent(&intent).await?;
            return Ok(FundingReadiness::Pending);
        }

        let target = required_prefund.max(U256::from(tempo::TEMPO_FLOAT_TARGET));
        let amount = target
            .checked_sub(relayer_balance)
            .ok_or_else(|| ExecutorItemError("Tempo relayer funding amount underflow".into()))?;
        if amount.is_zero() {
            return Ok(FundingReadiness::Ready);
        }
        let amount_u128 = u128::try_from(amount)
            .map_err(|_| ExecutorItemError("Tempo relayer top-up exceeds uint128".into()))?;
        let transfer_calldata = tempo::path_usd_transfer_calldata(relayer, amount);

        let calls = [
            RpcBatchCall {
                method: "eth_getTransactionCount",
                params: json!([self.treasury_address.to_string(), "pending"]),
            },
            RpcBatchCall {
                method: "eth_call",
                params: json!([{
                    "to": tempo::PATH_USD.to_string(),
                    "data": format!("0x{}", hex::encode(tempo::path_usd_balance_calldata(self.treasury_address))),
                }, "latest"]),
            },
            RpcBatchCall {
                method: "eth_estimateGas",
                params: json!([{
                    "from": self.treasury_address.to_string(),
                    "to": tempo::PATH_USD.to_string(),
                    "data": format!("0x{}", hex::encode(&transfer_calldata)),
                    "feeToken": tempo::PATH_USD.to_string(),
                }, "latest"]),
            },
        ];
        let responses = self
            .rpc
            .batch(chain_id, &calls)
            .await
            .map_err(rpc_item_error)?;
        let nonce = u64::try_from(response_quantity(&responses, 0, "Tempo treasury nonce")?)
            .map_err(|_| ExecutorItemError("Tempo treasury nonce exceeds uint64".into()))?;
        let treasury_balance = response_abi_u256(&responses, 1, "Tempo treasury pathUSD balance")?;
        let top_up_gas_limit = u64::try_from(response_quantity(
            &responses,
            2,
            "Tempo pathUSD top-up eth_estimateGas",
        )?)
        .map_err(|_| ExecutorItemError("Tempo pathUSD top-up gas estimate exceeds uint64".into()))?
        .checked_mul(TEMPO_TOP_UP_GAS_BUFFER_BPS)
        .map(|value| value / 10_000)
        .ok_or_else(|| ExecutorItemError("Tempo pathUSD top-up gas buffer overflow".into()))?;
        let top_up_gas_cost =
            tempo_cost_in_path_usd(U256::from(top_up_gas_limit), U256::from(max_fee_per_gas))?;
        let required_treasury = amount
            .checked_add(top_up_gas_cost)
            .and_then(|value| value.checked_add(U256::from(tempo::TEMPO_TREASURY_FLOOR)))
            .ok_or_else(|| {
                ExecutorItemError("Tempo treasury balance requirement overflow".into())
            })?;
        if treasury_balance < required_treasury {
            tracing::warn!(
                chain_id,
                treasury_path_usd_balance = %treasury_balance,
                required_path_usd = %required_treasury,
                top_up_path_usd = %amount,
                top_up_gas_limit,
                top_up_gas_path_usd = %top_up_gas_cost,
                reserve_path_usd = tempo::TEMPO_TREASURY_FLOOR,
                "Tempo treasury cannot fund the pending relayer top-up"
            );
            return Err(ExecutorItemError(
                "Tempo treasury pathUSD is below top-up amount, gas, and reserve floor".into(),
            ));
        }

        self.ensure_lease(lease_scope, lease_token).await?;
        let signed = sign_tempo(
            &self.treasury_key,
            TempoTransactionPlan {
                chain_id,
                nonce,
                gas_limit: top_up_gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas: 0,
                fee_token: tempo::PATH_USD,
                to: tempo::PATH_USD,
                input: transfer_calldata,
            },
        )
        .map_err(|error| ExecutorItemError(error.to_string()))?;
        let intent = PreparedFundingIntent {
            chain_id,
            relayer: relayer.to_string(),
            amount_wei: amount_u128,
            raw_transaction: format!("0x{}", hex::encode(&signed.raw_transaction)),
            transaction_hash: signed.transaction_hash,
            nonce: signed.nonce,
        };
        self.ensure_lease(lease_scope, lease_token).await?;
        if !self
            .store
            .save_prepared_funding_intent(&intent)
            .await
            .map_err(store_item_error)?
        {
            if let Some(existing) = self
                .store
                .get_prepared_funding_intent(chain_id)
                .await
                .map_err(store_item_error)?
            {
                self.resume_funding_intent(&existing).await?;
                return Ok(FundingReadiness::Pending);
            }
            return Err(ExecutorItemError(
                "another Tempo treasury relayer top-up is pending".into(),
            ));
        }
        self.broadcast_funding_intent(&intent).await?;
        tracing::info!(
            chain_id,
            relayer = %relayer,
            amount_path_usd = amount_u128,
            transaction_hash = %intent.transaction_hash,
            "submitted Tempo treasury pathUSD relayer top-up"
        );
        Ok(FundingReadiness::Pending)
    }

    #[allow(clippy::too_many_arguments)]
    async fn ensure_relayer_funded(
        &self,
        chain_id: u64,
        relayer: Address,
        relayer_balance: U256,
        required_prefund: U256,
        max_fee_per_gas: u128,
        max_priority_fee_per_gas: u128,
        top_up_max: U256,
    ) -> Result<FundingReadiness, ExecutorItemError> {
        let minimum = required_prefund.max(U256::from(self.config.relayer_float_min_wei));
        if relayer_balance >= minimum {
            return Ok(FundingReadiness::Ready);
        }

        let scope = format!("treasury:{chain_id}");
        let token = unique_token("treasury");
        if !self
            .store
            .acquire_lease(&scope, &token, self.config.lease_ttl)
            .await
            .map_err(store_item_error)?
        {
            return Ok(FundingReadiness::Pending);
        }
        let result = self
            .run_with_lease_heartbeat(
                &scope,
                &token,
                self.ensure_relayer_funded_locked(
                    chain_id,
                    relayer,
                    relayer_balance,
                    required_prefund,
                    max_fee_per_gas,
                    max_priority_fee_per_gas,
                    top_up_max,
                    &scope,
                    &token,
                ),
            )
            .await;
        if let Err(error) = self.store.release_lease(&scope, &token).await {
            tracing::warn!(chain_id, %error, "could not release treasury nonce lease");
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn ensure_relayer_funded_locked(
        &self,
        chain_id: u64,
        relayer: Address,
        relayer_balance: U256,
        required_prefund: U256,
        max_fee_per_gas: u128,
        max_priority_fee_per_gas: u128,
        top_up_max: U256,
        lease_scope: &str,
        lease_token: &str,
    ) -> Result<FundingReadiness, ExecutorItemError> {
        if let Some(intent) = self
            .store
            .get_prepared_funding_intent(chain_id)
            .await
            .map_err(store_item_error)?
        {
            self.resume_funding_intent(&intent).await?;
            return Ok(FundingReadiness::Pending);
        }

        let target_from_cost = required_prefund
            .checked_mul(U256::from(self.config.relayer_float_cost_multiplier))
            .ok_or_else(|| ExecutorItemError("relayer float target overflow".into()))?;
        let target = target_from_cost
            .max(U256::from(self.config.relayer_float_target_wei))
            .max(U256::from(self.config.relayer_float_min_wei));
        let amount = target
            .checked_sub(relayer_balance)
            .ok_or_else(|| ExecutorItemError("relayer funding amount underflow".into()))?;
        let deficit = required_prefund.saturating_sub(relayer_balance);
        if amount > top_up_max || deficit > top_up_max {
            return Err(ExecutorItemError(format!(
                "required relayer top-up exceeds the per-transfer cap: amount={amount}, deficit={deficit}, cap={top_up_max}"
            )));
        }
        let amount_u128 = u128::try_from(amount)
            .map_err(|_| ExecutorItemError("top-up amount exceeds uint128".into()))?;

        let calls = [
            RpcBatchCall {
                method: "eth_getTransactionCount",
                params: json!([self.treasury_address.to_string(), "pending"]),
            },
            RpcBatchCall {
                method: "eth_getBalance",
                params: json!([self.treasury_address.to_string(), "pending"]),
            },
        ];
        let responses = self
            .rpc
            .batch(chain_id, &calls)
            .await
            .map_err(rpc_item_error)?;
        let nonce = u64::try_from(response_quantity(
            &responses,
            0,
            "treasury eth_getTransactionCount",
        )?)
        .map_err(|_| ExecutorItemError("treasury nonce exceeds uint64".into()))?;
        let treasury_balance = response_quantity(&responses, 1, "treasury eth_getBalance")?;
        let top_up_gas_cost = U256::from(TOP_UP_GAS_LIMIT)
            .checked_mul(U256::from(max_fee_per_gas))
            .ok_or_else(|| ExecutorItemError("top-up gas cost overflow".into()))?;
        let required_treasury = amount
            .checked_add(top_up_gas_cost)
            .and_then(|value| value.checked_add(U256::from(self.config.treasury_floor_wei)))
            .ok_or_else(|| ExecutorItemError("treasury balance requirement overflow".into()))?;
        if treasury_balance < required_treasury {
            tracing::warn!(
                chain_id,
                treasury_native_balance = %treasury_balance,
                required_native_balance = %required_treasury,
                top_up_native_amount = %amount,
                top_up_gas_cost = %top_up_gas_cost,
                reserve_native_amount = self.config.treasury_floor_wei,
                "treasury cannot fund the pending relayer top-up"
            );
            return Err(ExecutorItemError(
                "treasury balance is below top-up amount, gas, and reserve floor".into(),
            ));
        }

        self.ensure_lease(lease_scope, lease_token).await?;
        let signed = sign_eip1559(
            &self.treasury_key,
            TransactionPlan {
                chain_id,
                nonce,
                gas_limit: TOP_UP_GAS_LIMIT,
                max_fee_per_gas,
                max_priority_fee_per_gas,
                to: relayer,
                value: amount,
                input: Bytes::new(),
            },
        )
        .map_err(|error| ExecutorItemError(error.to_string()))?;
        let intent = PreparedFundingIntent {
            chain_id,
            relayer: relayer.to_string(),
            amount_wei: amount_u128,
            raw_transaction: format!("0x{}", hex::encode(&signed.raw_transaction)),
            transaction_hash: signed.transaction_hash,
            nonce: signed.nonce,
        };
        self.ensure_lease(lease_scope, lease_token).await?;
        if !self
            .store
            .save_prepared_funding_intent(&intent)
            .await
            .map_err(store_item_error)?
        {
            if let Some(existing) = self
                .store
                .get_prepared_funding_intent(chain_id)
                .await
                .map_err(store_item_error)?
            {
                self.resume_funding_intent(&existing).await?;
                return Ok(FundingReadiness::Pending);
            }
            return Err(ExecutorItemError(
                "another treasury relayer top-up is pending".into(),
            ));
        }
        self.broadcast_funding_intent(&intent).await?;
        tracing::info!(
            chain_id,
            relayer = %relayer,
            amount_wei = amount_u128,
            transaction_hash = %intent.transaction_hash,
            "submitted treasury relayer gas top-up"
        );
        Ok(FundingReadiness::Pending)
    }

    async fn resume_funding_intent(
        &self,
        intent: &PreparedFundingIntent,
    ) -> Result<(), ExecutorItemError> {
        self.broadcast_funding_intent(intent).await?;
        let claimed = self
            .store
            .acquire_lease(
                &format!("receipt:{}:{}", intent.chain_id, intent.transaction_hash),
                &unique_token("funding-receipt"),
                self.config.receipt_poll_interval,
            )
            .await
            .map_err(store_item_error)?;
        if !claimed {
            return Ok(());
        }
        let receipt = self
            .rpc
            .call(
                intent.chain_id,
                "eth_getTransactionReceipt",
                json!([intent.transaction_hash]),
            )
            .await
            .map_err(rpc_item_error)?;
        if receipt.is_null() {
            return Ok(());
        }
        let Some(success) = receipt_succeeded(&receipt) else {
            return Err(ExecutorItemError(
                "funding transaction receipt has invalid status".into(),
            ));
        };
        self.store
            .clear_prepared_funding_intent(intent.chain_id, &intent.transaction_hash)
            .await
            .map_err(store_item_error)?;
        self.broadcast_seen
            .lock()
            .await
            .remove(&intent.transaction_hash);
        if !success {
            tracing::error!(
                chain_id = intent.chain_id,
                relayer = %intent.relayer,
                amount_wei = intent.amount_wei,
                transaction_hash = %intent.transaction_hash,
                "treasury relayer top-up transaction reverted"
            );
            return Err(ExecutorItemError(format!(
                "treasury relayer top-up transaction reverted: {}",
                intent.transaction_hash
            )));
        }
        tracing::info!(
            chain_id = intent.chain_id,
            relayer = %intent.relayer,
            amount_wei = intent.amount_wei,
            transaction_hash = %intent.transaction_hash,
            "treasury relayer gas top-up included"
        );
        Ok(())
    }

    async fn broadcast_funding_intent(
        &self,
        intent: &PreparedFundingIntent,
    ) -> Result<(), ExecutorItemError> {
        let raw = validate_raw_transaction(&intent.raw_transaction, &intent.transaction_hash)?;
        if self
            .recently_confirmed_broadcast(&intent.transaction_hash)
            .await
        {
            return Ok(());
        }
        let outcome = match self
            .rpc
            .broadcast_raw_transaction(intent.chain_id, &raw)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                return Err(rpc_item_error(error));
            }
        };
        match outcome {
            BroadcastOutcome::Accepted(hash)
                if hash.eq_ignore_ascii_case(&intent.transaction_hash) =>
            {
                self.remember_confirmed_broadcast(&intent.transaction_hash)
                    .await;
                Ok(())
            }
            BroadcastOutcome::Accepted(_) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                Err(ExecutorItemError(
                    "RPC returned a different funding transaction hash".into(),
                ))
            }
            BroadcastOutcome::Ambiguous(reason) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                tracing::debug!(
                    chain_id = intent.chain_id,
                    transaction_hash = %intent.transaction_hash,
                    reason,
                    "funding broadcast is ambiguous; retaining exact outbox"
                );
                Ok(())
            }
            BroadcastOutcome::Rejected(reason) => {
                self.broadcast_seen
                    .lock()
                    .await
                    .remove(&intent.transaction_hash);
                if self
                    .transaction_is_known(intent.chain_id, &intent.transaction_hash)
                    .await
                {
                    self.remember_confirmed_broadcast(&intent.transaction_hash)
                        .await;
                } else {
                    tracing::warn!(
                        chain_id = intent.chain_id,
                        transaction_hash = %intent.transaction_hash,
                        reason,
                        "rejected broadcast is unproven; retaining exact funding outbox"
                    );
                }
                Ok(())
            }
        }
    }
}

impl UserOperationHandler for ExecutorEngine {
    fn handle_batch(&self, operations: Vec<RoutedUserOperation>) -> UserOperationHandlerFuture<'_> {
        Box::pin(async move { self.handle_lane_batch(operations).await })
    }

    fn handle_malformed(
        &self,
        operation: MalformedUserOperation,
    ) -> MalformedUserOperationHandlerFuture<'_> {
        Box::pin(async move {
            self.store
                .save_malformed_dead_letter(
                    operation.chain_id,
                    operation.partition_id,
                    operation.offset,
                    &operation.payload,
                    &operation.error,
                    operation.user_operation_hash.as_deref(),
                    self.config.attempt_ttl,
                )
                .await
                .map(|_| ())
                .map_err(|error| Box::new(error) as UserOperationHandlerError)
        })
    }
}

fn has_stablecoin_payment(
    recipient: Address,
    chain_assets: &ChainAssetConfig,
    inputs: &[SettlementInput<'_>],
) -> bool {
    let allowlist = chain_assets
        .stablecoins
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();
    inputs.iter().any(|input| {
        parse_reimbursement(input.call_data, recipient, &allowlist)
            .is_ok_and(|reimbursement| !reimbursement.stablecoins.is_empty())
    })
}

/// Tempo's outer `0x76` gas limit deliberately comes from the UserOperations' declared limits,
/// rather than `eth_estimateGas`: EntryPoint catches an inner OOG and an estimate can therefore
/// succeed while a user's actual execution runs out of gas.
fn tempo_handle_ops_gas_limit(candidates: &[Candidate]) -> Result<u64, ExecutorItemError> {
    let declared = candidates.iter().try_fold(U256::ZERO, |total, candidate| {
        let limits = candidate.packed.packed.accountGasLimits.as_slice();
        let verification = U256::from_be_slice(&limits[..16]);
        let call = U256::from_be_slice(&limits[16..]);
        total
            .checked_add(verification)?
            .checked_add(call)?
            .checked_add(candidate.packed.packed.preVerificationGas)
    });
    let declared =
        declared.ok_or_else(|| ExecutorItemError("Tempo declared gas overflow".into()))?;
    let gas = declared
        .checked_mul(U256::from(64u8))
        .map(|value| value / U256::from(63u8))
        .and_then(|value| {
            value.checked_add(U256::from(candidates.len()).checked_mul(U256::from(50_000u64))?)
        })
        .and_then(|value| value.checked_add(U256::from(60_000u64)))
        .ok_or_else(|| ExecutorItemError("Tempo outer gas limit overflow".into()))?;
    u64::try_from(gas).map_err(|_| ExecutorItemError("Tempo outer gas limit exceeds uint64".into()))
}

/// Converts Tempo's `attodollars/gas` price to micro-pathUSD, always rounding up so the relay
/// never accepts an in-band reimbursement below the cost it is about to front.
fn tempo_cost_in_path_usd(gas: U256, price_atto: U256) -> Result<U256, ExecutorItemError> {
    let numerator = gas
        .checked_mul(price_atto)
        .and_then(|value| {
            value.checked_mul(U256::from(10u8).pow(U256::from(tempo::PATH_USD_DECIMALS)))
        })
        .ok_or_else(|| ExecutorItemError("Tempo pathUSD cost overflow".into()))?;
    let denominator = U256::from(10u8).pow(U256::from(18u8));
    let quotient = numerator / denominator;
    let remainder = numerator % denominator;
    quotient
        .checked_add(U256::from(u8::from(!remainder.is_zero())))
        .ok_or_else(|| ExecutorItemError("Tempo pathUSD cost overflow".into()))
}

fn marked_tempo_cost(cost: U256, markup_bps: u64) -> Result<U256, ExecutorItemError> {
    let numerator = cost
        .checked_mul(U256::from(markup_bps))
        .ok_or_else(|| ExecutorItemError("Tempo settlement markup overflow".into()))?;
    let denominator = U256::from(10_000u64);
    let marked = (numerator / denominator)
        .checked_add(U256::from(u8::from(!(numerator % denominator).is_zero())))
        .ok_or_else(|| ExecutorItemError("Tempo settlement markup overflow".into()))?;
    // Keep the same $0.01 minimum used by the generic stablecoin settlement path.
    Ok(marked.max(U256::from(10u128.pow(tempo::PATH_USD_DECIMALS - 2))))
}

fn candidate_from_record(
    result_index: usize,
    routed: &RoutedUserOperation,
    record: StoredUserOperation,
    pool_width: usize,
) -> Result<Candidate, &'static str> {
    let hash = B256::from_str(&routed.user_operation_hash)
        .map_err(|_| "queue UserOperation hash is invalid")?;
    let entry_point = Address::from_str(&routed.entry_point)
        .map_err(|_| "queue EntryPoint address is invalid")?;
    if relayer_index_for_sender(&routed.sender, pool_width) != routed.lane as usize {
        return Err("sender route does not match relayer lane");
    }
    let packed = PackedOperation::try_from(&record.user_operation)
        .map_err(|_| "could not pack queued UserOperation")?;
    if packed.has_eip7702_authorization {
        return Err("EIP-7702 UserOperations are not enabled in the executor");
    }
    if !packed
        .sender
        .to_string()
        .eq_ignore_ascii_case(&routed.sender)
    {
        return Err("queue sender does not match UserOperation sender");
    }
    if user_operation_hash(&packed, entry_point, routed.chain_id) != hash {
        return Err("queue UserOperation hash does not match immutable payload");
    }
    Ok(Candidate {
        result_index,
        hash,
        hash_string: routed.user_operation_hash.to_ascii_lowercase(),
        entry_point,
        packed,
        delayed_operation: delayed_operation_from_routed(routed),
    })
}

fn queued_operation_from_routed(
    routed: &RoutedUserOperation,
    pool_width: usize,
) -> Result<QueuedUserOperation, &'static str> {
    let operation = serde_json::from_value::<UserOperation>(routed.user_operation.clone())
        .map_err(|_| "queue UserOperation payload is not canonical v0.7 JSON")?;
    if serde_json::to_value(&operation).ok().as_ref() != Some(&routed.user_operation) {
        return Err("queue UserOperation payload is not canonical JSON");
    }
    let entry_point = Address::from_str(&routed.entry_point)
        .map_err(|_| "queue EntryPoint address is invalid")?;
    let hash = B256::from_str(&routed.user_operation_hash)
        .map_err(|_| "queue UserOperation hash is invalid")?;
    let packed =
        PackedOperation::try_from(&operation).map_err(|_| "could not pack queue UserOperation")?;
    if packed.has_eip7702_authorization {
        return Err("EIP-7702 UserOperations are not enabled in the executor");
    }
    if !packed
        .sender
        .to_string()
        .eq_ignore_ascii_case(&routed.sender)
    {
        return Err("queue sender does not match UserOperation sender");
    }
    if relayer_index_for_sender(&routed.sender, pool_width) != routed.lane as usize {
        return Err("sender route does not match relayer lane");
    }
    if user_operation_hash(&packed, entry_point, routed.chain_id) != hash {
        return Err("queue UserOperation hash does not match immutable payload");
    }
    Ok(QueuedUserOperation {
        user_operation_hash: routed.user_operation_hash.to_ascii_lowercase(),
        chain_id: routed.chain_id,
        entry_point: routed.entry_point.clone(),
        user_operation: operation,
    })
}

fn delayed_operation_from_routed(routed: &RoutedUserOperation) -> DelayedUserOperation {
    DelayedUserOperation {
        schema_version: routed.schema_version,
        user_operation_hash: routed.user_operation_hash.to_ascii_lowercase(),
        chain_id: routed.chain_id,
        entry_point: routed.entry_point.clone(),
        user_operation: routed.user_operation.clone(),
        sender: routed.sender.clone(),
        lane: routed.lane,
        stream: routed.stream.clone(),
        partition_id: routed.partition_id,
        offset: routed.offset,
    }
}

fn routed_operation_from_delayed(operation: &DelayedUserOperation) -> RoutedUserOperation {
    RoutedUserOperation {
        schema_version: operation.schema_version,
        user_operation_hash: operation.user_operation_hash.clone(),
        chain_id: operation.chain_id,
        entry_point: operation.entry_point.clone(),
        user_operation: operation.user_operation.clone(),
        sender: operation.sender.clone(),
        lane: operation.lane,
        stream: operation.stream.clone(),
        partition_id: operation.partition_id,
        offset: operation.offset,
    }
}

fn queue_record_matches(routed: &RoutedUserOperation, record: &StoredUserOperation) -> bool {
    record.chain_id == routed.chain_id
        && record.entry_point.eq_ignore_ascii_case(&routed.entry_point)
        && serde_json::to_value(&record.user_operation).ok().as_ref()
            == Some(&routed.user_operation)
}

fn admission_action(admitted: bool, envelope_matches: bool) -> AdmissionAction {
    match (admitted, envelope_matches) {
        (_, false) => AdmissionAction::DeadLetter,
        (false, true) => AdmissionAction::Recover,
        (true, true) => AdmissionAction::Execute,
    }
}

fn is_durable_status(status: UserOperationStatusKind) -> bool {
    matches!(
        status,
        UserOperationStatusKind::Submitted
            | UserOperationStatusKind::Rejected
            | UserOperationStatusKind::Included
            | UserOperationStatusKind::Failed
    )
}

fn item_error(message: &str) -> Result<(), UserOperationHandlerError> {
    Err(Box::new(ExecutorItemError(message.into())))
}

fn store_item_error(error: impl Display) -> ExecutorItemError {
    ExecutorItemError(error.to_string())
}

fn rpc_item_error(error: RpcError) -> ExecutorItemError {
    ExecutorItemError(error.to_string())
}

fn response_value<'a>(
    responses: &'a [Result<Value, RpcError>],
    index: usize,
    method: &str,
) -> Result<&'a Value, ExecutorItemError> {
    match responses.get(index) {
        Some(Ok(value)) => Ok(value),
        Some(Err(error)) => Err(ExecutorItemError(format!("{method} failed: {error}"))),
        None => Err(ExecutorItemError(format!(
            "{method} is missing from the RPC batch response"
        ))),
    }
}

fn response_quantity(
    responses: &[Result<Value, RpcError>],
    index: usize,
    method: &str,
) -> Result<U256, ExecutorItemError> {
    response_value(responses, index, method)?
        .as_str()
        .and_then(parse_quantity)
        .ok_or_else(|| ExecutorItemError(format!("{method} returned an invalid quantity")))
}

fn response_abi_u256(
    responses: &[Result<Value, RpcError>],
    index: usize,
    method: &str,
) -> Result<U256, ExecutorItemError> {
    let bytes = response_value(responses, index, method)?
        .as_str()
        .and_then(parse_hex_bytes)
        .filter(|bytes| bytes.len() == 32)
        .ok_or_else(|| ExecutorItemError(format!("{method} returned invalid ABI data")))?;
    Ok(U256::from_be_slice(&bytes))
}

fn response_quantity_optional(responses: &[Result<Value, RpcError>], index: usize) -> Option<U256> {
    responses
        .get(index)
        .and_then(|response| response.as_ref().ok())
        .and_then(Value::as_str)
        .and_then(parse_quantity)
}

fn parse_quantity(value: &str) -> Option<U256> {
    let digits = value.strip_prefix("0x")?;
    if digits.is_empty()
        || (digits.len() > 1 && digits.starts_with('0'))
        || !digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    U256::from_str_radix(digits, 16).ok()
}

fn nonce_too_low(reason: &str) -> bool {
    reason.to_ascii_lowercase().contains("nonce too low")
}

/// Converts Binance's decimal `SYMBOLUSDT` quote into an 8-decimal USD fixed-point value.
/// Extra precision rounds upward so a stablecoin reimbursement never undercharges the relay.
fn parse_market_usd_price(value: &str) -> Option<U256> {
    let value = value.trim();
    let mut parts = value.split('.');
    let whole = parts.next()?;
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    let scale = U256::from(USD_PRICE_SCALE);
    let whole = U256::from_str(whole).ok()?.checked_mul(scale)?;
    let kept = &fraction[..fraction.len().min(USD_PRICE_DECIMALS as usize)];
    let fraction = if kept.is_empty() {
        U256::ZERO
    } else {
        U256::from_str(kept)
            .ok()?
            .checked_mul(U256::from(10u8).pow(U256::from(USD_PRICE_DECIMALS - kept.len() as u32)))?
    };
    let mut price = whole.checked_add(fraction)?;
    if value
        .split_once('.')
        .is_some_and(|(_, fraction)| fraction.len() > USD_PRICE_DECIMALS as usize)
        && value.split_once('.').is_some_and(|(_, fraction)| {
            fraction[USD_PRICE_DECIMALS as usize..]
                .bytes()
                .any(|byte| byte != b'0')
        })
    {
        price = price.checked_add(U256::ONE)?;
    }
    (!price.is_zero()).then_some(price)
}

/// Convert a USD-denominated relayer funding cap into a chain's smallest native unit,
/// rounding up so a positive USD cap never becomes zero through integer division.
fn native_amount_for_usd_cap(
    native_decimals: u32,
    native_usd_price: U256,
    usd_cap: u64,
) -> Option<U256> {
    if native_usd_price.is_zero() || native_decimals > 38 {
        return None;
    }
    let native_scale =
        (0..native_decimals).try_fold(U256::ONE, |value, _| value.checked_mul(U256::from(10u8)))?;
    let numerator = U256::from(usd_cap)
        .checked_mul(U256::from(USD_PRICE_SCALE))?
        .checked_mul(native_scale)?;
    let quotient = numerator / native_usd_price;
    let remainder = numerator % native_usd_price;
    quotient.checked_add(U256::from(u8::from(!remainder.is_zero())))
}

fn parse_hex_bytes(value: &str) -> Option<Bytes> {
    let digits = value.strip_prefix("0x")?;
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    hex::decode(digits).ok().map(Into::into)
}

fn validate_raw_transaction(
    raw_transaction: &str,
    transaction_hash: &str,
) -> Result<Vec<u8>, ExecutorItemError> {
    let raw = parse_hex_bytes(raw_transaction)
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| ExecutorItemError("prepared raw transaction is invalid".into()))?;
    if !matches!(raw.first(), Some(0x02 | 0x76)) {
        return Err(ExecutorItemError(
            "prepared transaction is not a supported type 0x02 or Tempo type 0x76".into(),
        ));
    }
    let expected = B256::from_str(transaction_hash)
        .map_err(|_| ExecutorItemError("prepared transaction hash is invalid".into()))?;
    if alloy::primitives::keccak256(&raw) != expected {
        return Err(ExecutorItemError(
            "prepared transaction hash does not match raw bytes".into(),
        ));
    }
    Ok(raw.to_vec())
}

fn failure_results(count: usize, message: &str) -> UserOperationBatchResults {
    (0..count).map(|_| item_error(message)).collect()
}

fn finish_results(
    results: Vec<Option<Result<(), UserOperationHandlerError>>>,
    default_error: &str,
) -> UserOperationBatchResults {
    results
        .into_iter()
        .map(|result| result.unwrap_or_else(|| item_error(default_error)))
        .collect()
}

fn unique_token(prefix: &str) -> String {
    let counter = LEASE_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}:{}:{timestamp}:{counter}", std::process::id())
}

#[cfg(test)]
mod tests {
    use alloy::primitives::{B256, U256};
    use serde_json::json;

    use super::{
        AdmissionAction, ExecutorItemError, NATIVE_TOP_UP_USD_CAP, RpcError, admission_action,
        marked_tempo_cost, native_amount_for_usd_cap, nonce_too_low, parse_hex_bytes,
        parse_market_usd_price, parse_quantity, response_quantity, tempo_cost_in_path_usd,
        validate_raw_transaction,
    };
    use crate::utils::tempo;

    #[test]
    fn parses_canonical_rpc_quantities_only() {
        assert_eq!(parse_quantity("0x0"), Some(U256::ZERO));
        assert_eq!(parse_quantity("0x2a"), Some(U256::from(42u8)));
        assert_eq!(parse_quantity("0xABC"), Some(U256::from(0xabcu16)));
        for invalid in ["", "0x", "2a", "0x00", "0xgg"] {
            assert_eq!(parse_quantity(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn parses_binance_native_usd_prices_with_bundler_favourable_rounding() {
        assert_eq!(
            parse_market_usd_price("3024.12"),
            Some(U256::from(302_412_000_000u64))
        );
        assert_eq!(
            parse_market_usd_price("1.0000000001"),
            Some(U256::from(100_000_001u64))
        );
        for invalid in ["", "0", "-1", "1e3", "1.2.3"] {
            assert_eq!(parse_market_usd_price(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn converts_twenty_usd_top_up_cap_to_native_units_with_ceiling_rounding() {
        // MATIC at $0.20: $20 is exactly 100 MATIC.
        assert_eq!(
            native_amount_for_usd_cap(18, U256::from(20_000_000u64), NATIVE_TOP_UP_USD_CAP),
            Some(U256::from(100_000_000_000_000_000_000u128))
        );
        // ETH at $2,500: $20 is 0.008 ETH.
        assert_eq!(
            native_amount_for_usd_cap(18, U256::from(250_000_000_000u64), NATIVE_TOP_UP_USD_CAP,),
            Some(U256::from(8_000_000_000_000_000u64))
        );
        // A non-integral conversion is rounded toward the relayer.
        assert_eq!(
            native_amount_for_usd_cap(18, U256::from(300_000_000u64), NATIVE_TOP_UP_USD_CAP),
            Some(U256::from(6_666_666_666_666_666_667u128))
        );
        assert_eq!(
            native_amount_for_usd_cap(18, U256::ZERO, NATIVE_TOP_UP_USD_CAP),
            None
        );
        assert_eq!(
            native_amount_for_usd_cap(39, U256::ONE, NATIVE_TOP_UP_USD_CAP),
            None
        );
    }

    #[test]
    fn recognizes_a_nonce_too_low_broadcast_diagnostic() {
        assert!(nonce_too_low(
            "RPC code -32000: nonce too low: next nonce 1, tx nonce 0"
        ));
        assert!(nonce_too_low("NONCE TOO LOW"));
        assert!(!nonce_too_low("replacement transaction underpriced"));
    }

    #[test]
    fn batch_quantity_helper_distinguishes_errors_and_invalid_values() {
        let responses = vec![
            Ok(json!("0x2a")),
            Err(RpcError::Unavailable),
            Ok(json!(null)),
        ];
        assert_eq!(
            response_quantity(&responses, 0, "eth_test").unwrap(),
            U256::from(42u8)
        );
        assert!(response_quantity(&responses, 1, "eth_test").is_err());
        assert!(response_quantity(&responses, 2, "eth_test").is_err());
        assert!(response_quantity(&responses, 3, "eth_test").is_err());
    }

    #[test]
    fn validates_raw_transaction_type_and_hash() {
        let raw = [0x02, 0x01, 0x02, 0x03];
        let hash = alloy::primitives::keccak256(raw).to_string();
        assert_eq!(validate_raw_transaction("0x02010203", &hash).unwrap(), raw);
        assert!(validate_raw_transaction("0x01010203", &hash).is_err());
        assert!(validate_raw_transaction("0x02010203", &B256::ZERO.to_string()).is_err());
        assert!(parse_hex_bytes("0x1").is_none());
    }

    #[test]
    fn prices_tempo_path_usd_with_ceiling_and_the_default_one_point_five_x_gate() {
        // 100,000 gas at Tempo's 20e9 attodollar base fee is exactly 0.002 pathUSD.
        assert_eq!(
            tempo_cost_in_path_usd(
                U256::from(100_000u64),
                U256::from(tempo::TEMPO_BASE_FEE_ATTO),
            )
            .unwrap(),
            U256::from(2_000u64)
        );
        // The normal in-band 1.5x markup still applies, then the common $0.01 floor protects
        // micro-transactions from consuming a relayer float for a dust reimbursement.
        assert_eq!(
            marked_tempo_cost(U256::from(2_000u64), 15_000).unwrap(),
            U256::from(10_000u64)
        );
        assert_eq!(
            marked_tempo_cost(U256::from(20_000u64), 15_000).unwrap(),
            U256::from(30_000u64)
        );
    }

    #[test]
    fn executor_item_error_is_sendable() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ExecutorItemError>();
    }

    #[test]
    fn recovers_only_a_matching_unadmitted_queue_record() {
        assert_eq!(admission_action(true, true), AdmissionAction::Execute);
        assert_eq!(admission_action(false, true), AdmissionAction::Recover);
        assert_eq!(admission_action(true, false), AdmissionAction::DeadLetter);
        assert_eq!(admission_action(false, false), AdmissionAction::DeadLetter);
    }
}
