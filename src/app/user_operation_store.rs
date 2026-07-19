use std::{
    fmt::{Display, Formatter},
    time::Duration,
};

use redis::{FromRedisValue, aio::MultiplexedConnection};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    app::rpc::types::{
        TransactionHash, UserOperation, UserOperationStatus, UserOperationStatusKind,
    },
    utils::config::RedisConfig,
};

const USER_OPERATION_TTL_SECS: u64 = 60 * 60;
const STATUS_KEY_PREFIX: &str = "vela:relay:user-operation:";
const BUNDLE_KEY_PREFIX: &str = "vela:relay:user-operation-bundle:";

const PATCH_RECORD_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local record = cjson.decode(raw)
local patch = cjson.decode(ARGV[1])
for key, value in pairs(patch) do
  record[key] = value
end
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
"#;

const DELETE_UNADMITTED_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local record = cjson.decode(raw)
if record['admitted'] then
  return 0
end
return redis.call('DEL', KEYS[1])
"#;

const CLAIM_SUBMITTED_RECEIPT_CHECK_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local record = cjson.decode(raw)
if record['status'] ~= 'submitted' then
  return 0
end
if (record['nextReceiptCheckAtMs'] or 0) > tonumber(ARGV[1]) then
  return 0
end
record['nextReceiptCheckAtMs'] = tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
"#;

#[expect(
    dead_code,
    reason = "The Iggy handleOps consumer is deployed separately and uses this transition contract."
)]
const MARK_BUNDLE_SUBMITTED_SCRIPT: &str = r#"
local updated = 0
for index = 2, #KEYS do
  local raw = redis.call('GET', KEYS[index])
  if raw then
    local record = cjson.decode(raw)
    record['status'] = 'submitted'
    record['transactionHash'] = ARGV[1]
    record['admitted'] = true
    redis.call('SET', KEYS[index], cjson.encode(record), 'KEEPTTL')
    redis.call('SADD', KEYS[1], ARGV[index])
    updated = updated + 1
  end
end
if updated > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
end
return updated
"#;

/// Redis-backed lifecycle state for an accepted UserOperation.
///
/// `admitted` is an internal two-phase marker: a `queued` record is created before the Iggy
/// append, then marked admitted only after Iggy acknowledges it. It is never exposed via RPC.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredUserOperation {
    pub status: UserOperationStatusKind,
    pub transaction_hash: Option<TransactionHash>,
    pub chain_id: u64,
    pub entry_point: String,
    pub user_operation: UserOperation,
    pub admitted: bool,
    #[serde(default)]
    pub next_receipt_check_at_ms: u64,
    pub block_hash: Option<String>,
    pub block_number: Option<String>,
    pub receipt: Option<Value>,
    pub event: Option<UserOperationEvent>,
}

impl StoredUserOperation {
    pub fn rpc_status(&self) -> UserOperationStatus {
        UserOperationStatus {
            status: self.status,
            transaction_hash: self.transaction_hash.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueuedUserOperation {
    pub user_operation_hash: String,
    pub chain_id: u64,
    pub entry_point: String,
    pub user_operation: UserOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOperationEvent {
    pub user_operation_hash: String,
    pub success: bool,
    pub actual_gas_cost: String,
    pub actual_gas_used: String,
}

#[derive(Clone)]
pub struct UserOperationStatusStore {
    connection: MultiplexedConnection,
    command_timeout: Duration,
}

#[derive(Debug)]
pub struct UserOperationStatusStoreError(&'static str);

impl Display for UserOperationStatusStoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for UserOperationStatusStoreError {}

impl UserOperationStatusStore {
    pub async fn connect(config: &RedisConfig) -> Result<Self, UserOperationStatusStoreError> {
        let client = redis::Client::open(config.url.as_str())
            .map_err(|_| UserOperationStatusStoreError("invalid Redis connection configuration"))?;
        let connection = tokio::time::timeout(
            config.command_timeout,
            client.get_multiplexed_async_connection(),
        )
        .await
        .map_err(|_| UserOperationStatusStoreError("Redis connection timed out"))?
        .map_err(|_| UserOperationStatusStoreError("could not connect to Redis"))?;
        let store = Self {
            connection,
            command_timeout: config.command_timeout,
        };
        let pong: String = store.query(redis::cmd("PING")).await?;
        if pong != "PONG" {
            return Err(UserOperationStatusStoreError("Redis health check failed"));
        }
        tracing::info!(
            ttl_secs = USER_OPERATION_TTL_SECS,
            "Redis UserOperation status store connected"
        );
        Ok(store)
    }

    /// Creates the initial `queued` record atomically. `false` means this exact UserOperation is
    /// already known and must not be appended to Iggy a second time.
    pub async fn create_queued(
        &self,
        operation: QueuedUserOperation,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let record = StoredUserOperation {
            status: UserOperationStatusKind::Queued,
            transaction_hash: None,
            chain_id: operation.chain_id,
            entry_point: operation.entry_point,
            user_operation: operation.user_operation,
            admitted: false,
            next_receipt_check_at_ms: 0,
            block_hash: None,
            block_number: None,
            receipt: None,
            event: None,
        };
        let payload = serde_json::to_string(&record).map_err(|_| {
            UserOperationStatusStoreError("could not serialize UserOperation status")
        })?;
        let mut command = redis::cmd("SET");
        command
            .arg(status_key(&operation.user_operation_hash))
            .arg(payload)
            .arg("NX")
            .arg("EX")
            .arg(USER_OPERATION_TTL_SECS);
        let reply: Option<String> = self.query(command).await?;
        Ok(reply.is_some())
    }

    pub async fn get(
        &self,
        user_operation_hash: &str,
    ) -> Result<Option<StoredUserOperation>, UserOperationStatusStoreError> {
        let mut command = redis::cmd("GET");
        command.arg(status_key(user_operation_hash));
        let payload: Option<String> = self.query(command).await?;
        payload
            .map(|payload| {
                serde_json::from_str(&payload).map_err(|_| {
                    UserOperationStatusStoreError("stored UserOperation status is invalid")
                })
            })
            .transpose()
    }

    /// Completes the Redis half of admission after Iggy confirms the append. The update preserves
    /// the original one-hour TTL and does not overwrite a later worker transition.
    pub async fn mark_admitted(
        &self,
        user_operation_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        self.patch(user_operation_hash, json!({ "admitted": true }))
            .await
    }

    /// Compensates a failed Iggy append. A record already advanced by a consumer is left intact.
    pub async fn delete_if_unadmitted(
        &self,
        user_operation_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(DELETE_UNADMITTED_SCRIPT)
            .arg(1)
            .arg(status_key(user_operation_hash));
        let deleted: i64 = self.query(command).await?;
        Ok(deleted == 1)
    }

    /// Atomically coalesces receipt checks for a submitted transaction. This preserves the Redis
    /// TTL while preventing many concurrent status polls from issuing the same chain RPC call.
    pub async fn claim_submitted_receipt_check(
        &self,
        user_operation_hash: &str,
        now_ms: u64,
        next_check_at_ms: u64,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(CLAIM_SUBMITTED_RECEIPT_CHECK_SCRIPT)
            .arg(1)
            .arg(status_key(user_operation_hash))
            .arg(now_ms)
            .arg(next_check_at_ms);
        let claimed: i64 = self.query(command).await?;
        Ok(claimed == 1)
    }

    /// Called by the Iggy consumer after a handleOps transaction has been accepted into the
    /// mempool. Every hash is indexed by that transaction so later receipt checks update the
    /// whole bundle together.
    #[expect(
        dead_code,
        reason = "The Iggy handleOps consumer is deployed separately and uses this transition contract."
    )]
    pub async fn mark_bundle_submitted(
        &self,
        chain_id: u64,
        transaction_hash: &str,
        user_operation_hashes: &[String],
    ) -> Result<usize, UserOperationStatusStoreError> {
        if user_operation_hashes.is_empty() {
            return Ok(0);
        }

        let mut command = redis::cmd("EVAL");
        command
            .arg(MARK_BUNDLE_SUBMITTED_SCRIPT)
            .arg(user_operation_hashes.len() + 1)
            .arg(bundle_key(chain_id, transaction_hash));
        for hash in user_operation_hashes {
            command.arg(status_key(hash));
        }
        command.arg(transaction_hash);
        for hash in user_operation_hashes {
            command.arg(hash);
        }
        command.arg(USER_OPERATION_TTL_SECS);
        let updated: i64 = self.query(command).await?;
        Ok(updated as usize)
    }

    /// A reverted handleOps transaction fails every UserOperation in its bundle.
    pub async fn mark_bundle_failed(
        &self,
        chain_id: u64,
        transaction_hash: &str,
        receipt: Value,
    ) -> Result<(), UserOperationStatusStoreError> {
        let hashes = self.bundle_hashes(chain_id, transaction_hash).await?;
        for hash in hashes {
            self.patch(
                &hash,
                receipt_patch(
                    UserOperationStatusKind::Failed,
                    transaction_hash,
                    &receipt,
                    None,
                ),
            )
            .await?;
        }
        Ok(())
    }

    /// Marks every operation in a handleOps attempt failed when execution fails before a usable
    /// transaction receipt is available.
    #[expect(
        dead_code,
        reason = "The Iggy handleOps consumer is deployed separately and uses this transition contract."
    )]
    pub async fn mark_handle_ops_failed(
        &self,
        user_operation_hashes: &[String],
    ) -> Result<(), UserOperationStatusStoreError> {
        for hash in user_operation_hashes {
            self.patch(
                hash,
                json!({ "status": UserOperationStatusKind::Failed, "admitted": true }),
            )
            .await?;
        }
        Ok(())
    }

    /// A successful handleOps transaction defaults bundle members to `rejected`, then upgrades
    /// only UserOperationEvent entries that completed successfully to `included`.
    pub async fn mark_bundle_confirmed(
        &self,
        chain_id: u64,
        transaction_hash: &str,
        receipt: Value,
        events: &[UserOperationEvent],
    ) -> Result<(), UserOperationStatusStoreError> {
        let hashes = self.bundle_hashes(chain_id, transaction_hash).await?;
        for hash in hashes {
            self.patch(
                &hash,
                receipt_patch(
                    UserOperationStatusKind::Rejected,
                    transaction_hash,
                    &receipt,
                    None,
                ),
            )
            .await?;
        }
        for event in events {
            let status = if event.success {
                UserOperationStatusKind::Included
            } else {
                UserOperationStatusKind::Rejected
            };
            self.patch(
                &event.user_operation_hash,
                receipt_patch(status, transaction_hash, &receipt, Some(event)),
            )
            .await?;
        }
        Ok(())
    }

    #[expect(
        dead_code,
        reason = "The Iggy handleOps consumer is deployed separately and uses this transition contract."
    )]
    pub async fn mark_rejected(
        &self,
        user_operation_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        self.patch(
            user_operation_hash,
            json!({ "status": UserOperationStatusKind::Rejected, "admitted": true }),
        )
        .await
    }

    /// Called by the Iggy consumer after it forwards a queued operation to its mempool but before
    /// any handleOps transaction containing it has been submitted.
    #[expect(
        dead_code,
        reason = "The Iggy handleOps consumer is deployed separately and uses this transition contract."
    )]
    pub async fn mark_not_submitted(
        &self,
        user_operation_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        self.patch(
            user_operation_hash,
            json!({ "status": UserOperationStatusKind::NotSubmitted, "admitted": true }),
        )
        .await
    }

    async fn bundle_hashes(
        &self,
        chain_id: u64,
        transaction_hash: &str,
    ) -> Result<Vec<String>, UserOperationStatusStoreError> {
        let mut command = redis::cmd("SMEMBERS");
        command.arg(bundle_key(chain_id, transaction_hash));
        self.query(command).await
    }

    async fn patch(
        &self,
        user_operation_hash: &str,
        patch: Value,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let patch = serde_json::to_string(&patch).map_err(|_| {
            UserOperationStatusStoreError("could not serialize UserOperation status")
        })?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(PATCH_RECORD_SCRIPT)
            .arg(1)
            .arg(status_key(user_operation_hash))
            .arg(patch);
        let updated: i64 = self.query(command).await?;
        Ok(updated == 1)
    }

    async fn query<T: FromRedisValue>(
        &self,
        command: redis::Cmd,
    ) -> Result<T, UserOperationStatusStoreError> {
        let mut connection = self.connection.clone();
        tokio::time::timeout(self.command_timeout, command.query_async(&mut connection))
            .await
            .map_err(|_| UserOperationStatusStoreError("Redis command timed out"))?
            .map_err(|_| UserOperationStatusStoreError("Redis command failed"))
    }
}

fn receipt_patch(
    status: UserOperationStatusKind,
    transaction_hash: &str,
    receipt: &Value,
    event: Option<&UserOperationEvent>,
) -> Value {
    let mut patch = json!({
        "status": status,
        "transactionHash": transaction_hash,
        "admitted": true,
        "receipt": receipt,
        "blockHash": receipt.get("blockHash"),
        "blockNumber": receipt.get("blockNumber"),
    });
    if let Some(event) = event {
        patch["event"] = serde_json::to_value(event).expect("UserOperation event is serializable");
    }
    patch
}

fn status_key(user_operation_hash: &str) -> String {
    format!("{STATUS_KEY_PREFIX}{user_operation_hash}")
}

fn bundle_key(chain_id: u64, transaction_hash: &str) -> String {
    format!("{BUNDLE_KEY_PREFIX}{chain_id}:{transaction_hash}")
}
