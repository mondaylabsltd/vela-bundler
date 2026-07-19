//! Deploy the Alto ERC-4337 simulation contracts through the canonical CREATE2 deployer.
//!
//! The command deliberately defaults to a dry run.  Broadcasting requires an
//! explicit `--broadcast`, so checking addresses and the maximum gas spend can
//! never accidentally spend treasury funds.
//!
//! ```text
//! cargo run --bin deploy-simulations -- --chain-id 143 --broadcast
//! ```

use std::{env, error::Error, str::FromStr, time::Duration};

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::{eip2718::Encodable2718, eip2930::AccessList},
    network::TxSignerSync,
    primitives::{Address, Bytes, TxKind, U256, keccak256},
    signers::local::PrivateKeySigner,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[allow(dead_code)]
#[path = "../utils/vault.rs"]
mod vault;

const MONAD_CHAIN_ID: u64 = 143;
const MONAD_RPC_URL: &str = "https://rpc.monad.xyz";
const DETERMINISTIC_DEPLOYER: &str = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const PIMLICO_ARTIFACT_NAME: &str = "PimlicoSimulations";
const ENTRY_POINT_V07_ARTIFACT_NAME: &str = "EntryPointSimulations07";
const PIMLICO_ARTIFACT_JSON: &str = include_str!("../../contracts/alto/PimlicoSimulations.json");
const ENTRY_POINT_V07_ARTIFACT_JSON: &str =
    include_str!("../../contracts/alto/EntryPointSimulations07.json");

struct Args {
    chain_id: u64,
    rpc_url: String,
    broadcast: bool,
}

struct ContractArtifact {
    name: &'static str,
    json: &'static str,
}

struct SignedTransaction {
    hash: String,
    raw: Vec<u8>,
}

struct DeploymentPlan {
    name: &'static str,
    contract_address: Address,
    deployment_data: Vec<u8>,
    gas_limit: u64,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenvy::dotenv().ok();
    let args = parse_args()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let rpc_chain_id: String = rpc(&client, &args.rpc_url, "eth_chainId", json!([])).await?;
    let actual_chain_id = parse_quantity_u64(&rpc_chain_id)?;
    if actual_chain_id != args.chain_id {
        return Err(format!(
            "RPC chain ID is {actual_chain_id}, but --chain-id is {}",
            args.chain_id
        )
        .into());
    }

    let operator_secret = env::var("OPERATOR_SECRET")
        .map_err(|_| "OPERATOR_SECRET is required to derive the treasury signer")?;
    let treasury_key = vault::derive_treasury_secret_key(&operator_secret)?;
    let treasury_address = Address::from_str(&vault::derive_address(&operator_secret)?)?;
    let deployer = Address::from_str(DETERMINISTIC_DEPLOYER)?;
    let deployer_code: String = rpc(
        &client,
        &args.rpc_url,
        "eth_getCode",
        json!([deployer.to_string(), "latest"]),
    )
    .await?;
    if deployer_code == "0x" {
        return Err(format!(
            "canonical CREATE2 deployer {deployer} is absent on chain {}",
            args.chain_id
        )
        .into());
    }

    let balance: String = rpc(
        &client,
        &args.rpc_url,
        "eth_getBalance",
        json!([treasury_address.to_string(), "latest"]),
    )
    .await?;
    let treasury_balance = parse_quantity_u128(&balance)?;
    let salt = keccak256(treasury_address.as_slice());

    println!("chain_id={actual_chain_id}");
    println!("treasury={treasury_address}");
    println!("treasury_balance_wei={treasury_balance}");
    println!("create2_deployer={deployer}");
    println!("create2_salt=0x{}", hex::encode(salt));
    println!(
        "mode={}",
        if args.broadcast {
            "broadcast"
        } else {
            "dry-run"
        }
    );

    let artifacts = [
        ContractArtifact {
            name: PIMLICO_ARTIFACT_NAME,
            json: PIMLICO_ARTIFACT_JSON,
        },
        ContractArtifact {
            name: ENTRY_POINT_V07_ARTIFACT_NAME,
            json: ENTRY_POINT_V07_ARTIFACT_JSON,
        },
    ];

    let mut plans = Vec::new();
    let mut total_max_cost = 0_u128;
    for artifact in artifacts {
        let init_code = read_init_code(artifact.name, artifact.json)?;
        let contract_address = create2_address(deployer, salt, &init_code);
        let deployed_code: String = rpc(
            &client,
            &args.rpc_url,
            "eth_getCode",
            json!([contract_address.to_string(), "latest"]),
        )
        .await?;

        if deployed_code != "0x" {
            println!(
                "contract={} address={} status=already-deployed code_bytes={}",
                artifact.name,
                contract_address,
                (deployed_code.len().saturating_sub(2)) / 2
            );
            continue;
        }

        let deployment_data = [salt.as_slice(), init_code.as_slice()].concat();
        let estimate: String = rpc(
            &client,
            &args.rpc_url,
            "eth_estimateGas",
            json!([{
                "from": treasury_address.to_string(),
                "to": deployer.to_string(),
                "data": format!("0x{}", hex::encode(&deployment_data)),
                "value": "0x0"
            }]),
        )
        .await?;
        let estimated_gas = parse_quantity_u64(&estimate)?;
        let gas_limit = estimated_gas.saturating_mul(120).saturating_div(100);
        let (max_priority_fee_per_gas, max_fee_per_gas) =
            eip1559_fees(&client, &args.rpc_url).await?;
        let max_cost = u128::from(gas_limit).saturating_mul(max_fee_per_gas);
        println!(
            "contract={} address={} status=ready estimated_gas={} gas_limit={} max_fee_per_gas={} max_cost_wei={}",
            artifact.name, contract_address, estimated_gas, gas_limit, max_fee_per_gas, max_cost
        );
        total_max_cost = total_max_cost.saturating_add(max_cost);
        plans.push(DeploymentPlan {
            name: artifact.name,
            contract_address,
            deployment_data,
            gas_limit,
            max_fee_per_gas,
            max_priority_fee_per_gas,
        });
    }

    println!("total_max_cost_wei={total_max_cost}");
    if args.broadcast && treasury_balance < total_max_cost {
        return Err(format!(
            "treasury balance is insufficient for the complete deployment: has {treasury_balance} wei, maximum total cost is {total_max_cost} wei; no transaction was broadcast"
        )
        .into());
    }

    for plan in plans {
        if !args.broadcast {
            continue;
        }

        let nonce: String = rpc(
            &client,
            &args.rpc_url,
            "eth_getTransactionCount",
            json!([treasury_address.to_string(), "pending"]),
        )
        .await?;
        let signed = sign_eip1559(
            &treasury_key,
            args.chain_id,
            parse_quantity_u64(&nonce)?,
            plan.gas_limit,
            plan.max_fee_per_gas,
            plan.max_priority_fee_per_gas,
            deployer,
            plan.deployment_data,
        )?;
        let submitted_hash: String = rpc(
            &client,
            &args.rpc_url,
            "eth_sendRawTransaction",
            json!([format!("0x{}", hex::encode(&signed.raw))]),
        )
        .await?;
        if !submitted_hash.eq_ignore_ascii_case(&signed.hash) {
            return Err(format!(
                "RPC returned a transaction hash different from the signed transaction: expected {}, got {submitted_hash}",
                signed.hash
            )
            .into());
        }
        println!("contract={} submitted_tx={submitted_hash}", plan.name);

        let receipt = wait_for_receipt(&client, &args.rpc_url, &submitted_hash).await?;
        let status = receipt
            .get("status")
            .and_then(Value::as_str)
            .ok_or("deployment receipt has no status")?;
        if status != "0x1" {
            return Err(format!("{} deployment reverted in {submitted_hash}", plan.name).into());
        }
        let code: String = rpc(
            &client,
            &args.rpc_url,
            "eth_getCode",
            json!([plan.contract_address.to_string(), "latest"]),
        )
        .await?;
        if code == "0x" {
            return Err(format!(
                "{} transaction succeeded but no code was found at {contract_address}",
                plan.name,
                contract_address = plan.contract_address
            )
            .into());
        }
        println!(
            "contract={} address={} status=deployed code_bytes={}",
            plan.name,
            plan.contract_address,
            (code.len().saturating_sub(2)) / 2
        );
    }

    Ok(())
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut chain_id = MONAD_CHAIN_ID;
    let mut rpc_url = MONAD_RPC_URL.to_owned();
    let mut broadcast = false;
    let mut values = env::args().skip(1);
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--chain-id" => {
                chain_id = values
                    .next()
                    .ok_or("--chain-id requires a value")?
                    .parse()?;
            }
            "--rpc-url" => rpc_url = values.next().ok_or("--rpc-url requires a value")?,
            "--broadcast" => broadcast = true,
            "--help" | "-h" => {
                println!(
                    "Usage: cargo run --bin deploy-simulations -- [--chain-id ID] [--rpc-url URL] [--broadcast]"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    Ok(Args {
        chain_id,
        rpc_url,
        broadcast,
    })
}

fn read_init_code(name: &str, json: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    let artifact: Value = serde_json::from_str(json)?;
    let bytecode = artifact
        .pointer("/bytecode/object")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("artifact {name} has no bytecode.object"))?;
    let hex_code = bytecode.strip_prefix("0x").unwrap_or(bytecode);
    Ok(hex::decode(hex_code)?)
}

fn create2_address(deployer: Address, salt: alloy::primitives::B256, init_code: &[u8]) -> Address {
    let mut preimage = Vec::with_capacity(85);
    preimage.push(0xff);
    preimage.extend_from_slice(deployer.as_slice());
    preimage.extend_from_slice(salt.as_slice());
    preimage.extend_from_slice(keccak256(init_code).as_slice());
    let hash = keccak256(preimage);
    Address::from_slice(&hash.as_slice()[12..])
}

async fn eip1559_fees(
    client: &reqwest::Client,
    rpc_url: &str,
) -> Result<(u128, u128), Box<dyn Error>> {
    let latest: Value = rpc(
        client,
        rpc_url,
        "eth_getBlockByNumber",
        json!(["latest", false]),
    )
    .await?;
    let base_fee = latest
        .get("baseFeePerGas")
        .and_then(Value::as_str)
        .ok_or("latest block has no baseFeePerGas")?;
    let priority: String = rpc(client, rpc_url, "eth_maxPriorityFeePerGas", json!([])).await?;
    let priority = parse_quantity_u128(&priority)?;
    let max_fee = parse_quantity_u128(base_fee)?
        .saturating_mul(2)
        .saturating_add(priority);
    Ok((priority, max_fee))
}

#[allow(clippy::too_many_arguments)]
fn sign_eip1559(
    secret_key: &k256::SecretKey,
    chain_id: u64,
    nonce: u64,
    gas_limit: u64,
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
    to: Address,
    input: Vec<u8>,
) -> Result<SignedTransaction, Box<dyn Error>> {
    let signer = PrivateKeySigner::from(secret_key.clone());
    let mut transaction = TxEip1559 {
        chain_id,
        nonce,
        gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        to: TxKind::Call(to),
        value: U256::ZERO,
        access_list: AccessList::default(),
        input: Bytes::from(input),
    };
    let signature = signer.sign_transaction_sync(&mut transaction)?;
    let envelope: TxEnvelope = transaction.into_signed(signature).into();
    Ok(SignedTransaction {
        hash: envelope.hash().to_string(),
        raw: envelope.encoded_2718(),
    })
}

async fn wait_for_receipt(
    client: &reqwest::Client,
    rpc_url: &str,
    transaction_hash: &str,
) -> Result<Value, Box<dyn Error>> {
    for _ in 0..30 {
        let receipt: Option<Value> = rpc(
            client,
            rpc_url,
            "eth_getTransactionReceipt",
            json!([transaction_hash]),
        )
        .await?;
        if let Some(receipt) = receipt {
            return Ok(receipt);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!("timed out waiting for transaction receipt {transaction_hash}").into())
}

async fn rpc<T: DeserializeOwned>(
    client: &reqwest::Client,
    rpc_url: &str,
    method: &str,
    params: Value,
) -> Result<T, Box<dyn Error>> {
    let response: Value = client
        .post(rpc_url)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if let Some(error) = response.get("error") {
        return Err(format!("{method} failed: {error}").into());
    }
    serde_json::from_value(
        response
            .get("result")
            .cloned()
            .ok_or_else(|| format!("{method} response has no result"))?,
    )
    .map_err(Into::into)
}

fn parse_quantity_u64(value: &str) -> Result<u64, Box<dyn Error>> {
    Ok(u64::from_str_radix(
        value
            .strip_prefix("0x")
            .ok_or("RPC quantity is missing 0x prefix")?,
        16,
    )?)
}

fn parse_quantity_u128(value: &str) -> Result<u128, Box<dyn Error>> {
    Ok(u128::from_str_radix(
        value
            .strip_prefix("0x")
            .ok_or("RPC quantity is missing 0x prefix")?,
        16,
    )?)
}
