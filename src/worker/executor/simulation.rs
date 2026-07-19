use std::str::FromStr;

use alloy::primitives::{Address, B256, Bytes, U256, address, b256, keccak256};
use serde_json::{Value, json};

use super::{
    abi::{PackedOperation, handle_ops_calldata, pimlico_simulate_handle_op_calldata},
    rpc::{RpcBatchCall, RpcError, TrustedRpcClient},
};

const DETERMINISTIC_DEPLOYER: Address = address!("4e59b44847b379578588920ca78fbf26c0b4956c");
const PIMLICO_SIMULATIONS_INIT_CODE_HASH: B256 =
    b256!("6d2eb1ee903947960a7faf13c49dc4b9deb468b3c7a6d19863c4d9b2bffd78d1");
const ENTRY_POINT_SIMULATIONS_V07_INIT_CODE_HASH: B256 =
    b256!("5ec5a546872ae8196c7627fe2a5c89e0a23614070cbd474dbce5e97b82d40c94");

#[derive(Clone, Copy, Debug)]
struct PimlicoSimulationContracts {
    pimlico: Address,
    entry_point_v07: Address,
}

#[derive(Clone, Debug)]
pub(super) struct SimulatedLog {
    pub(super) address: Address,
    pub(super) topics: Vec<B256>,
    pub(super) data: Bytes,
}

#[derive(Clone, Debug)]
pub(super) struct SimulatedUserOperation {
    pub(super) user_operation_hash: B256,
    pub(super) success: bool,
    pub(super) actual_gas_used: U256,
}

#[derive(Clone, Debug)]
pub(super) struct SimulationResult {
    pub(super) gas_used: U256,
    pub(super) events: Vec<SimulatedUserOperation>,
    pub(super) logs: Vec<SimulatedLog>,
}

#[derive(Debug)]
pub(super) enum SimulationVerdict<T> {
    Success(T),
    NonceMismatch,
    Rejected(&'static str),
    Transient(&'static str),
}

/// Runs every candidate in isolation in one JSON-RPC HTTP batch. Each simulation executes a
/// one-operation `handleOps`, which proves both EntryPoint validation and the account call. A
/// top-level `eth_simulateV1` error is a provider capability failure, never an op verdict.
///
/// When `eth_simulateV1` is unavailable, a deployed Alto simulation pair is the preferred
/// fallback because it works through ordinary `eth_call`. `debug_traceCall` remains a fallback
/// for chains where the pair has not yet been deployed or a node cannot execute `eth_call`.
pub(super) async fn simulate_individually(
    rpc: &TrustedRpcClient,
    chain_id: u64,
    entry_point: Address,
    relayer: Address,
    beneficiary: Address,
    operations: &[PackedOperation],
    hashes: &[B256],
) -> Vec<SimulationVerdict<SimulationResult>> {
    debug_assert_eq!(operations.len(), hashes.len());
    let calls = operations
        .iter()
        .map(|operation| RpcBatchCall {
            method: "eth_simulateV1",
            params: simulate_params(
                relayer,
                entry_point,
                handle_ops_calldata(std::slice::from_ref(&operation.packed), beneficiary),
            ),
        })
        .collect::<Vec<_>>();

    let mut verdicts: Vec<SimulationVerdict<SimulationResult>> =
        match rpc.batch(chain_id, &calls).await {
            Ok(responses) => responses
                .into_iter()
                .zip(hashes)
                .map(|(response, expected_hash)| match response {
                    Ok(value) => parse_simulation(value, entry_point, &[*expected_hash]),
                    Err(RpcError::Reverted { .. }) => {
                        // `eth_simulateV1` reports a real call verdict inside `result`. A top-level
                        // error means the RPC could not perform the method, even if its message says
                        // revert.
                        SimulationVerdict::Transient("individual simulation method unavailable")
                    }
                    Err(_) => SimulationVerdict::Transient("individual simulation RPC unavailable"),
                })
                .collect(),
            Err(_) => hashes
                .iter()
                .map(|_| SimulationVerdict::Transient("individual simulation RPC unavailable"))
                .collect(),
        };

    let fallback_indexes = verdicts
        .iter()
        .enumerate()
        .filter_map(|(index, verdict)| {
            matches!(verdict, SimulationVerdict::Transient(_)).then_some(index)
        })
        .collect::<Vec<_>>();
    if fallback_indexes.is_empty() {
        return verdicts;
    }
    let pimlico_contracts = pimlico_contracts(rpc, chain_id, beneficiary).await;
    let mut trace_indexes = Vec::new();
    for index in fallback_indexes {
        let verdict = simulate_with_pimlico(
            rpc,
            chain_id,
            entry_point,
            operations[index].clone(),
            hashes[index],
            pimlico_contracts,
        )
        .await;
        if matches!(verdict, SimulationVerdict::Transient(_)) {
            trace_indexes.push(index);
        } else {
            verdicts[index] = verdict;
        }
    }
    if trace_indexes.is_empty() {
        return verdicts;
    }
    let trace_calls = trace_indexes
        .iter()
        .map(|index| RpcBatchCall {
            method: "debug_traceCall",
            params: debug_trace_params(
                relayer,
                entry_point,
                handle_ops_calldata(&[operations[*index].packed.clone()], beneficiary),
            ),
        })
        .collect::<Vec<_>>();
    let trace_responses = rpc.batch(chain_id, &trace_calls).await;
    for (position, index) in trace_indexes.into_iter().enumerate() {
        verdicts[index] = match trace_responses
            .as_ref()
            .ok()
            .and_then(|responses| responses.get(position))
        {
            Some(Ok(value)) => parse_trace_simulation(value.clone(), entry_point, &[hashes[index]]),
            _ => SimulationVerdict::Transient(
                "no trusted executor RPC supports eth_simulateV1, deployed Pimlico eth_call, or debug_traceCall",
            ),
        };
    }
    verdicts
}

pub(super) async fn simulate_bundle(
    rpc: &TrustedRpcClient,
    chain_id: u64,
    entry_point: Address,
    relayer: Address,
    beneficiary: Address,
    operations: &[PackedOperation],
    hashes: &[B256],
) -> SimulationVerdict<SimulationResult> {
    let calldata = handle_ops_calldata(
        &operations
            .iter()
            .map(|operation| operation.packed.clone())
            .collect::<Vec<_>>(),
        beneficiary,
    );
    match rpc
        .call(
            chain_id,
            "eth_simulateV1",
            simulate_params(relayer, entry_point, calldata.clone()),
        )
        .await
    {
        Ok(value) => parse_simulation(value, entry_point, hashes),
        Err(_) => {
            if let Some(contracts) = pimlico_contracts(rpc, chain_id, beneficiary).await {
                let verdict = simulate_bundle_with_eth_call(
                    rpc,
                    chain_id,
                    entry_point,
                    relayer,
                    calldata.clone(),
                    hashes,
                    contracts,
                )
                .await;
                if !matches!(verdict, SimulationVerdict::Transient(_)) {
                    return verdict;
                }
            }
            match rpc
                .call(
                    chain_id,
                    "debug_traceCall",
                    debug_trace_params(relayer, entry_point, calldata),
                )
                .await
            {
                Ok(value) => parse_trace_simulation(value, entry_point, hashes),
                Err(_) => SimulationVerdict::Transient(
                    "no trusted executor RPC supports eth_simulateV1, deployed Pimlico eth_call, or debug_traceCall",
                ),
            }
        }
    }
}

async fn pimlico_contracts(
    rpc: &TrustedRpcClient,
    chain_id: u64,
    treasury: Address,
) -> Option<PimlicoSimulationContracts> {
    let salt = keccak256(treasury.as_slice());
    let contracts = PimlicoSimulationContracts {
        pimlico: create2_address(
            DETERMINISTIC_DEPLOYER,
            salt,
            PIMLICO_SIMULATIONS_INIT_CODE_HASH,
        ),
        entry_point_v07: create2_address(
            DETERMINISTIC_DEPLOYER,
            salt,
            ENTRY_POINT_SIMULATIONS_V07_INIT_CODE_HASH,
        ),
    };
    let calls = [
        RpcBatchCall {
            method: "eth_getCode",
            params: json!([contracts.pimlico.to_string(), "latest"]),
        },
        RpcBatchCall {
            method: "eth_getCode",
            params: json!([contracts.entry_point_v07.to_string(), "latest"]),
        },
    ];
    let Ok(responses) = rpc.batch(chain_id, &calls).await else {
        return None;
    };
    responses
        .iter()
        .all(|response| {
            response
                .as_ref()
                .ok()
                .and_then(Value::as_str)
                .is_some_and(|code| code != "0x")
        })
        .then_some(contracts)
}

async fn simulate_with_pimlico(
    rpc: &TrustedRpcClient,
    chain_id: u64,
    entry_point: Address,
    operation: PackedOperation,
    hash: B256,
    contracts: Option<PimlicoSimulationContracts>,
) -> SimulationVerdict<SimulationResult> {
    let Some(contracts) = contracts else {
        return SimulationVerdict::Transient(
            "no trusted executor RPC supports eth_simulateV1, debug_traceCall, or deployed Pimlico simulations",
        );
    };
    let data =
        pimlico_simulate_handle_op_calldata(contracts.entry_point_v07, entry_point, &operation);
    match rpc
        .simulate(
            chain_id,
            "eth_call",
            json!([{
                "to": contracts.pimlico.to_string(),
                "data": format!("0x{}", hex::encode(data)),
            }, "latest"]),
        )
        .await
    {
        // `simulateHandleOp` reverts for an invalid EntryPoint validation or account call. It has
        // no logs by design, but individual verdicts are used only to decide bundle membership.
        Ok(_) => SimulationVerdict::Success(SimulationResult {
            gas_used: U256::ZERO,
            events: vec![SimulatedUserOperation {
                user_operation_hash: hash,
                success: true,
                actual_gas_used: U256::ZERO,
            }],
            logs: Vec::new(),
        }),
        Err(RpcError::Reverted { message, data }) => {
            if revert_reports_nonce_mismatch(&message, data.as_deref()) {
                SimulationVerdict::NonceMismatch
            } else {
                SimulationVerdict::Rejected(
                    "Pimlico eth_call simulation reverted during EntryPoint validation or execution",
                )
            }
        }
        Err(_) => SimulationVerdict::Transient(
            "Pimlico eth_call simulation is unavailable on trusted executor RPCs",
        ),
    }
}

async fn simulate_bundle_with_eth_call(
    rpc: &TrustedRpcClient,
    chain_id: u64,
    entry_point: Address,
    relayer: Address,
    calldata: Bytes,
    hashes: &[B256],
    _contracts: PimlicoSimulationContracts,
) -> SimulationVerdict<SimulationResult> {
    // The individual Pimlico calls have already proven validation and account execution. The
    // standard `eth_estimateGas` here executes the exact final `handleOps` bundle, catching
    // inter-operation state conflicts without requiring a debug namespace.
    match rpc
        .simulate(
            chain_id,
            "eth_estimateGas",
            json!([{
                "from": relayer.to_string(),
                "to": entry_point.to_string(),
                "data": format!("0x{}", hex::encode(calldata)),
            }, "latest"]),
        )
        .await
    {
        Ok(value) => match value.as_str().and_then(parse_u256) {
            Some(gas_used) => SimulationVerdict::Success(SimulationResult {
                gas_used,
                // `eth_estimateGas` does not return logs or per-operation gas. Preserve each
                // expected hash so allocation charges the full outer estimate evenly rather than
                // crediting an unverified operation.
                events: hashes
                    .iter()
                    .copied()
                    .map(|user_operation_hash| SimulatedUserOperation {
                        user_operation_hash,
                        success: true,
                        actual_gas_used: U256::ZERO,
                    })
                    .collect(),
                logs: Vec::new(),
            }),
            None => SimulationVerdict::Transient(
                "Pimlico eth_call fallback returned an invalid eth_estimateGas quantity",
            ),
        },
        Err(RpcError::Reverted { .. }) => SimulationVerdict::Rejected(
            "final handleOps bundle reverted during eth_estimateGas fallback",
        ),
        Err(_) => SimulationVerdict::Transient(
            "Pimlico eth_call fallback could not estimate the final handleOps bundle",
        ),
    }
}

fn create2_address(deployer: Address, salt: B256, init_code_hash: B256) -> Address {
    let mut preimage = Vec::with_capacity(85);
    preimage.push(0xff);
    preimage.extend_from_slice(deployer.as_slice());
    preimage.extend_from_slice(salt.as_slice());
    preimage.extend_from_slice(init_code_hash.as_slice());
    let hash = keccak256(preimage);
    Address::from_slice(&hash.as_slice()[12..])
}

fn revert_reports_nonce_mismatch(message: &str, data: Option<&str>) -> bool {
    let message = message.to_ascii_lowercase();
    if message.contains("aa25") || message.contains("invalid account nonce") {
        return true;
    }
    let Some(data) = data.and_then(|data| data.strip_prefix("0x")) else {
        return false;
    };
    let Ok(bytes) = hex::decode(data) else {
        return false;
    };
    bytes
        .windows("aa25".len())
        .any(|window| window.eq_ignore_ascii_case(b"aa25"))
        || bytes
            .windows("invalid account nonce".len())
            .any(|window| window.eq_ignore_ascii_case(b"invalid account nonce"))
}

fn simulate_params(from: Address, entry_point: Address, calldata: Bytes) -> Value {
    json!([
        {
            "blockStateCalls": [{
                "calls": [{
                    "from": from.to_string(),
                    "to": entry_point.to_string(),
                    "data": format!("0x{}", hex::encode(calldata)),
                }]
            }],
            "validation": false,
            "traceTransfers": false,
        },
        "latest"
    ])
}

fn debug_trace_params(from: Address, entry_point: Address, calldata: Bytes) -> Value {
    json!([
        {
            "from": from.to_string(),
            "to": entry_point.to_string(),
            "data": format!("0x{}", hex::encode(calldata)),
        },
        "latest",
        {
            "tracer": "callTracer",
            "tracerConfig": { "withLog": true },
        }
    ])
}

fn parse_simulation(
    value: Value,
    entry_point: Address,
    expected_hashes: &[B256],
) -> SimulationVerdict<SimulationResult> {
    let Some(call) = value
        .get(0)
        .and_then(|block| block.get("calls"))
        .and_then(Value::as_array)
        .and_then(|calls| calls.first())
    else {
        return SimulationVerdict::Transient("simulation response has no call result");
    };

    let status = call
        .get("status")
        .and_then(Value::as_str)
        .and_then(parse_u256);
    match status {
        Some(status) if status == U256::from(1u8) => {}
        Some(status) if status.is_zero() && call_reports_nonce_mismatch(call) => {
            return SimulationVerdict::NonceMismatch;
        }
        Some(status) if status.is_zero() => {
            return SimulationVerdict::Rejected("handleOps reverted during simulation");
        }
        _ => return SimulationVerdict::Transient("simulation returned an invalid call status"),
    }

    let Some(gas_used) = call
        .get("gasUsed")
        .and_then(Value::as_str)
        .and_then(parse_u256)
    else {
        return SimulationVerdict::Transient("simulation response has no gasUsed");
    };
    let Some(raw_logs) = call.get("logs").and_then(Value::as_array) else {
        return SimulationVerdict::Transient("simulation response has no logs");
    };
    let logs = match raw_logs.iter().map(parse_log).collect::<Option<Vec<_>>>() {
        Some(logs) => logs,
        None => return SimulationVerdict::Transient("simulation returned malformed logs"),
    };
    simulation_from_logs(gas_used, logs, entry_point, expected_hashes)
}

fn parse_trace_simulation(
    value: Value,
    entry_point: Address,
    expected_hashes: &[B256],
) -> SimulationVerdict<SimulationResult> {
    if trace_reports_failure(&value) {
        return if trace_reports_nonce_mismatch(&value) {
            SimulationVerdict::NonceMismatch
        } else {
            SimulationVerdict::Rejected("handleOps reverted during debug trace simulation")
        };
    }
    let Some(gas_used) = value
        .get("gasUsed")
        .and_then(Value::as_str)
        .and_then(parse_u256)
    else {
        return SimulationVerdict::Transient("debug trace response has no gasUsed");
    };
    let Some(logs) = trace_logs(&value) else {
        return SimulationVerdict::Transient("debug trace returned malformed logs");
    };
    simulation_from_logs(gas_used, logs, entry_point, expected_hashes)
}

fn trace_reports_failure(trace: &Value) -> bool {
    trace
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|error| !error.is_empty())
        || trace
            .get("revertReason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.is_empty())
}

fn trace_reports_nonce_mismatch(trace: &Value) -> bool {
    ["error", "revertReason"]
        .into_iter()
        .filter_map(|field| trace.get(field).and_then(Value::as_str))
        .any(|message| {
            let message = message.to_ascii_lowercase();
            message.contains("aa25") || message.contains("invalid account nonce")
        })
}

fn trace_logs(trace: &Value) -> Option<Vec<SimulatedLog>> {
    let own_logs = match trace.get("logs") {
        Some(logs) => logs
            .as_array()?
            .iter()
            .map(parse_log)
            .collect::<Option<Vec<_>>>()?,
        None => Vec::new(),
    };
    let child_logs = match trace.get("calls") {
        Some(calls) => calls
            .as_array()?
            .iter()
            .map(trace_logs)
            .collect::<Option<Vec<_>>>()?,
        None => Vec::new(),
    };
    Some(
        own_logs
            .into_iter()
            .chain(child_logs.into_iter().flatten())
            .collect(),
    )
}

fn simulation_from_logs(
    gas_used: U256,
    logs: Vec<SimulatedLog>,
    entry_point: Address,
    expected_hashes: &[B256],
) -> SimulationVerdict<SimulationResult> {
    let event_signature =
        keccak256(b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    let events = logs
        .iter()
        .filter(|log| log.address == entry_point && log.topics.first() == Some(&event_signature))
        .map(parse_user_operation_event)
        .collect::<Option<Vec<_>>>();
    let Some(events) = events else {
        return SimulationVerdict::Transient("simulation returned malformed UserOperationEvent");
    };

    if events.len() != expected_hashes.len()
        || events
            .iter()
            .zip(expected_hashes)
            .any(|(event, expected)| event.user_operation_hash != *expected)
    {
        return SimulationVerdict::Rejected(
            "simulation did not emit the expected UserOperationEvent",
        );
    }
    if events.iter().any(|event| !event.success) {
        return SimulationVerdict::Rejected("UserOperation execution reverted during simulation");
    }

    SimulationVerdict::Success(SimulationResult {
        gas_used,
        events,
        logs,
    })
}

fn call_reports_nonce_mismatch(call: &Value) -> bool {
    let message = call
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    message.contains("aa25") || message.contains("invalid account nonce")
}

fn parse_log(value: &Value) -> Option<SimulatedLog> {
    let address = Address::from_str(value.get("address")?.as_str()?).ok()?;
    let topics = value
        .get("topics")?
        .as_array()?
        .iter()
        .map(|topic| B256::from_str(topic.as_str()?).ok())
        .collect::<Option<Vec<_>>>()?;
    let data = parse_bytes(value.get("data")?.as_str()?)?;
    Some(SimulatedLog {
        address,
        topics,
        data,
    })
}

fn parse_user_operation_event(log: &SimulatedLog) -> Option<SimulatedUserOperation> {
    let user_operation_hash = *log.topics.get(1)?;
    if log.data.len() < 4 * 32 {
        return None;
    }
    let success = parse_word(&log.data, 1)?;
    if success > U256::from(1) {
        return None;
    }
    // Word 2 is actualGasCost. In-band operations intentionally declare zero EntryPoint fees,
    // so the executor prices its outer transaction independently. Still decode it to require a
    // canonical complete event before using word 3.
    let _actual_gas_cost = parse_word(&log.data, 2)?;
    Some(SimulatedUserOperation {
        user_operation_hash,
        success: success == U256::from(1),
        actual_gas_used: parse_word(&log.data, 3)?,
    })
}

fn parse_word(data: &[u8], index: usize) -> Option<U256> {
    let start = index.checked_mul(32)?;
    let bytes: [u8; 32] = data.get(start..start + 32)?.try_into().ok()?;
    Some(U256::from_be_bytes(bytes))
}

fn parse_u256(value: &str) -> Option<U256> {
    U256::from_str_radix(value.strip_prefix("0x")?, 16).ok()
}

fn parse_bytes(value: &str) -> Option<Bytes> {
    let value = value.strip_prefix("0x")?;
    if !value.len().is_multiple_of(2) {
        return None;
    }
    hex::decode(value).ok().map(Into::into)
}

#[cfg(test)]
mod tests {
    use alloy::primitives::{address, b256};
    use serde_json::json;

    use super::{
        DETERMINISTIC_DEPLOYER, ENTRY_POINT_SIMULATIONS_V07_INIT_CODE_HASH,
        PIMLICO_SIMULATIONS_INIT_CODE_HASH, SimulationVerdict, create2_address, parse_simulation,
        parse_trace_simulation, revert_reports_nonce_mismatch,
    };

    #[test]
    fn ignores_forged_events_from_non_entry_point_addresses() {
        let hash = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let signature = alloy::primitives::keccak256(
            b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
        );
        let word = |value: u64| format!("{value:064x}");
        let response = json!([{
            "calls": [{
                "status": "0x1",
                "gasUsed": "0x100",
                "logs": [{
                    "address": "0x2222222222222222222222222222222222222222",
                    "topics": [signature.to_string(), hash.to_string()],
                    "data": format!("0x{}{}{}{}", word(0), word(1), word(10), word(9)),
                }]
            }]
        }]);

        assert!(matches!(
            parse_simulation(
                response,
                address!("1111111111111111111111111111111111111111"),
                &[hash]
            ),
            SimulationVerdict::Rejected(_)
        ));
    }

    #[test]
    fn accepts_only_an_explicit_success_call_status() {
        let hash = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let signature = alloy::primitives::keccak256(
            b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
        );
        let word = |value: u64| format!("{value:064x}");
        let response = |status: Option<&str>| {
            let mut call = json!({
                "gasUsed": "0x100",
                "logs": [{
                    "address": "0x1111111111111111111111111111111111111111",
                    "topics": [signature.to_string(), hash.to_string()],
                    "data": format!("0x{}{}{}{}", word(0), word(1), word(10), word(9)),
                }]
            });
            if let Some(status) = status {
                call["status"] = json!(status);
            }
            json!([{ "calls": [call] }])
        };
        let entry_point = address!("1111111111111111111111111111111111111111");

        assert!(matches!(
            parse_simulation(response(Some("0x1")), entry_point, &[hash]),
            SimulationVerdict::Success(_)
        ));
        assert!(matches!(
            parse_simulation(response(Some("0x0")), entry_point, &[hash]),
            SimulationVerdict::Rejected(_)
        ));
        for invalid in [None, Some("0x2"), Some("invalid")] {
            assert!(matches!(
                parse_simulation(response(invalid), entry_point, &[hash]),
                SimulationVerdict::Transient(_)
            ));
        }
    }

    #[test]
    fn classifies_only_explicit_account_nonce_errors_for_follow_up() {
        let entry_point = address!("1111111111111111111111111111111111111111");
        let hash = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        for message in [
            "FailedOp(0, AA25 invalid account nonce)",
            "Invalid Account Nonce",
        ] {
            let response = json!([{
                "calls": [{
                    "status": "0x0",
                    "error": { "message": message }
                }]
            }]);
            assert!(matches!(
                parse_simulation(response, entry_point, &[hash]),
                SimulationVerdict::NonceMismatch
            ));
        }

        let unrelated = json!([{
            "calls": [{
                "status": "0x0",
                "error": { "message": "AA24 signature error" }
            }]
        }]);
        assert!(matches!(
            parse_simulation(unrelated, entry_point, &[hash]),
            SimulationVerdict::Rejected(_)
        ));
    }

    #[test]
    fn accepts_a_nested_entry_point_event_from_debug_trace_call() {
        let entry_point = address!("1111111111111111111111111111111111111111");
        let hash = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let signature = alloy::primitives::keccak256(
            b"UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)",
        );
        let word = |value: u64| format!("{value:064x}");
        let trace = json!({
            "type": "CALL",
            "gasUsed": "0x120",
            "calls": [{
                "type": "CALL",
                "logs": [{
                    "address": entry_point.to_string(),
                    "topics": [signature.to_string(), hash.to_string()],
                    "data": format!("0x{}{}{}{}", word(0), word(1), word(10), word(9)),
                }]
            }]
        });

        assert!(matches!(
            parse_trace_simulation(trace, entry_point, &[hash]),
            SimulationVerdict::Success(_)
        ));
    }

    #[test]
    fn derives_the_deployed_monad_pimlico_addresses_from_the_treasury_salt() {
        let treasury = address!("ee2cca98ecbff34663591a925968fa4db5a1f0dd");
        let salt = alloy::primitives::keccak256(treasury.as_slice());
        assert_eq!(
            create2_address(
                DETERMINISTIC_DEPLOYER,
                salt,
                PIMLICO_SIMULATIONS_INIT_CODE_HASH
            ),
            address!("002ea30f431a34736439e98275b10350112de6ae")
        );
        assert_eq!(
            create2_address(
                DETERMINISTIC_DEPLOYER,
                salt,
                ENTRY_POINT_SIMULATIONS_V07_INIT_CODE_HASH,
            ),
            address!("e050ef4de2109ecded19dcc3d3f2120121d47ec5")
        );
    }

    #[test]
    fn recognizes_a_nonce_mismatch_embedded_in_pimlico_revert_data() {
        let error_data = "0x65c8fd4d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000194141323520696e76616c6964206163636f756e74206e6f6e636500000000000000";
        assert!(revert_reports_nonce_mismatch(
            "execution reverted",
            Some(error_data)
        ));
        assert!(!revert_reports_nonce_mismatch(
            "execution reverted",
            Some("0x65c8fd4d")
        ));
    }
}
