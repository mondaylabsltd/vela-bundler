use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fmt::{Display, Formatter},
    time::{Duration, SystemTime, UNIX_EPOCH},
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
const LEASE_KEY_PREFIX: &str = "vela:relay:lease:";
const PREPARED_BUNDLE_KEY_PREFIX: &str = "vela:relay:prepared-bundle:";
const PREPARED_BUNDLE_INDEX_KEY: &str = "vela:relay:prepared-bundle-index";
const PREPARED_FUNDING_KEY_PREFIX: &str = "vela:relay:prepared-funding:";
const TOP_UP_BUDGET_KEY_PREFIX: &str = "vela:relay:top-up-budget:";
const MALFORMED_DEAD_LETTER_KEY_PREFIX: &str = "vela:relay:malformed-dead-letter:";
const DELAYED_OPERATION_PAYLOAD_KEY_PREFIX: &str = "vela:relay:delayed-user-operation-payload:";
const DELAYED_OPERATION_KEY_PREFIX: &str = "vela:relay:delayed-user-operation:";
const DELAYED_OPERATION_CLAIM_KEY_PREFIX: &str = "vela:relay:delayed-user-operation-claim:";
const DELAYED_OPERATION_SCHEDULE_KEY: &str = "vela:relay:delayed-user-operation-schedule";
const DELAYED_RETRY_BASE_MS: u64 = 5_000;
const DELAYED_RETRY_MAX_MS: u64 = 5 * 60 * 1_000;

const PATCH_RECORD_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local record = cjson.decode(raw)
local patch = cjson.decode(ARGV[1])
local current_status = record['status']
local next_status = patch['status']
local allowed = {
  queued = {not_submitted = true, submitted = true, rejected = true, failed = true},
  not_submitted = {submitted = true, rejected = true, failed = true},
  submitted = {rejected = true, included = true, failed = true}
}
if next_status and next_status ~= current_status then
  local transitions = allowed[current_status]
  if not transitions or not transitions[next_status] then
    return 0
  end
end
for key, value in pairs(patch) do
  record[key] = value
end
redis.call('SET', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
"#;

const MARK_BUNDLE_SUBMITTED_SCRIPT: &str = r#"
local indexed = 0
for index = 2, #KEYS do
  local raw = redis.call('GET', KEYS[index])
  if raw then
    local record = cjson.decode(raw)
    local stored_chain_id = record['chainIdText']
    -- New records compare decimal strings so all uint64 chain IDs remain exact. The tostring
    -- fallback only supports legacy records when Lua can render their JSON number canonically;
    -- it deliberately fails closed for rounded/scientific values instead of aliasing chains.
    local same_chain = stored_chain_id == ARGV[2]
    if not stored_chain_id then
      same_chain = tostring(record['chainId']) == ARGV[2]
    end
    local current_status = record['status']
    local should_index = false
    if same_chain and (current_status == 'queued' or current_status == 'not_submitted') then
      record['status'] = 'submitted'
      record['transactionHash'] = ARGV[1]
      record['admitted'] = true
      redis.call('SET', KEYS[index], cjson.encode(record), 'KEEPTTL')
      should_index = true
    elseif same_chain and current_status == 'submitted' and record['transactionHash'] == ARGV[1] then
      should_index = true
    end
    if should_index then
      redis.call('SADD', KEYS[1], ARGV[index + 1])
      indexed = indexed + 1
    end
  end
end
if indexed > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
end
return indexed
"#;

const RENEW_LEASE_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
"#;

const RELEASE_LEASE_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
"#;

const SAVE_PREPARED_BUNDLE_SCRIPT: &str = r#"
local stored = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if not stored then
  return 0
end
redis.call('SADD', KEYS[2], KEYS[1])
return 1
"#;

const CLEAR_PREPARED_BUNDLE_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SREM', KEYS[2], KEYS[1])
  return 0
end
local intent = cjson.decode(raw)
if intent['transactionHash'] ~= ARGV[1] then
  return 0
end
local deleted = redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], KEYS[1])
return deleted
"#;

const LIST_PREPARED_BUNDLES_SCRIPT: &str = r#"
local result = {}
local members = redis.call('SMEMBERS', KEYS[1])
for _, key in ipairs(members) do
  local raw = redis.call('GET', key)
  if raw then
    table.insert(result, key)
    table.insert(result, raw)
  else
    redis.call('SREM', KEYS[1], key)
  end
end
return result
"#;

const CLEAR_PREPARED_FUNDING_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local intent = cjson.decode(raw)
if intent['transactionHash'] ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
"#;

// A confirmed revert did not transfer the reserved relayer float. Return that amount to the
// rolling budget atomically with removing the outbox record, so a failed funding transaction
// cannot leave a chain artificially blocked for the rest of the 24-hour window.
const CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local intent = cjson.decode(raw)
if intent['transactionHash'] ~= ARGV[1] then
  return 0
end

local function normalize_decimal(value)
  local normalized = string.gsub(value, '^0+', '')
  if normalized == '' then
    return '0'
  end
  return normalized
end

local function decimal_subtract(left, right)
  left = normalize_decimal(left)
  right = normalize_decimal(right)
  if string.len(left) < string.len(right) or (string.len(left) == string.len(right) and left < right) then
    return '0'
  end
  local result = {}
  local left_index = string.len(left)
  local right_index = string.len(right)
  local borrow = 0
  while left_index > 0 do
    local left_digit = string.byte(left, left_index) - string.byte('0') - borrow
    local right_digit = 0
    if right_index > 0 then
      right_digit = string.byte(right, right_index) - string.byte('0')
    end
    if left_digit < right_digit then
      left_digit = left_digit + 10
      borrow = 1
    else
      borrow = 0
    end
    table.insert(result, 1, string.char(string.byte('0') + left_digit - right_digit))
    left_index = left_index - 1
    right_index = right_index - 1
  end
  return normalize_decimal(table.concat(result))
end

local current = redis.call('GET', KEYS[2])
if current then
  local remaining = decimal_subtract(current, tostring(intent['amountWei']))
  if remaining == '0' then
    redis.call('DEL', KEYS[2])
  else
    redis.call('SET', KEYS[2], remaining, 'KEEPTTL')
  end
end
return redis.call('DEL', KEYS[1])
"#;

const RESERVE_AND_SAVE_FUNDING_SCRIPT: &str = r#"
local function normalize_decimal(value)
  local normalized = string.gsub(value, '^0+', '')
  if normalized == '' then
    return '0'
  end
  return normalized
end

local function decimal_greater(left, right)
  left = normalize_decimal(left)
  right = normalize_decimal(right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) > string.len(right)
  end
  return left > right
end

local function decimal_add(left, right)
  left = normalize_decimal(left)
  right = normalize_decimal(right)
  local result = {}
  local left_index = string.len(left)
  local right_index = string.len(right)
  local carry = 0
  while left_index > 0 or right_index > 0 or carry > 0 do
    local left_digit = 0
    local right_digit = 0
    if left_index > 0 then
      left_digit = string.byte(left, left_index) - 48
      left_index = left_index - 1
    end
    if right_index > 0 then
      right_digit = string.byte(right, right_index) - 48
      right_index = right_index - 1
    end
    local sum = left_digit + right_digit + carry
    table.insert(result, 1, string.char(48 + (sum % 10)))
    carry = math.floor(sum / 10)
  end
  return table.concat(result)
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end

local current = redis.call('GET', KEYS[2])
local budget_existed = current ~= false
local total = decimal_add(current or '0', ARGV[1])
if decimal_greater(total, ARGV[2]) then
  return -1
end

local stored = redis.call('SET', KEYS[1], ARGV[4], 'NX')
if not stored then
  return 0
end
redis.call('SET', KEYS[2], total, 'KEEPTTL')
if not budget_existed or redis.call('PTTL', KEYS[2]) < 0 then
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
return 1
"#;

const SAVE_DELAYED_OPERATION_SCRIPT: &str = r#"
local canonical = redis.call('GET', KEYS[1])
local existing = redis.call('HGET', KEYS[2], 'payload')
if (canonical and canonical ~= ARGV[1]) or (existing and existing ~= ARGV[2]) then
  return -1
end
if not canonical then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4])
else
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
end
if not existing then
  redis.call('HSET', KEYS[2], 'payload', ARGV[2], 'attempts', '0')
end

local attempts = redis.call('HINCRBY', KEYS[2], 'attempts', 1)
local delay = tonumber(ARGV[5])
local maximum = tonumber(ARGV[6])
local remaining = attempts
while remaining > 1 and delay < maximum do
  delay = math.min(delay * 2, maximum)
  remaining = remaining - 1
end
local redis_time = redis.call('TIME')
local now = redis_time[1] * 1000 + math.floor(redis_time[2] / 1000)
local due = now + delay

redis.call('HSET', KEYS[2], 'nextAttemptAtMs', tostring(due))
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[3], due, ARGV[3])
-- A worker reclassifying a claimed item as future nonce owns the lane lease. Invalidating the
-- claim prevents its scheduler from deleting the newly rescheduled item as a successful attempt.
redis.call('DEL', KEYS[4])
return attempts
"#;

const CLAIM_DELAYED_OPERATIONS_SCRIPT: &str = r#"
local redis_time = redis.call('TIME')
local now = redis_time[1] * 1000 + math.floor(redis_time[2] / 1000)
local identifiers = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, ARGV[2])
local claimed = {}
for _, identifier in ipairs(identifiers) do
  local item_key = ARGV[3] .. identifier
  local claim_key = ARGV[4] .. identifier
  local payload = redis.call('HGET', item_key, 'payload')
  if not payload then
    redis.call('ZREM', KEYS[1], identifier)
  else
    local acquired = redis.call('SET', claim_key, ARGV[1], 'NX', 'PX', ARGV[5])
    if acquired then
      -- Move the schedule score to the claim deadline. This avoids the first claimed page
      -- starving later due items, while a crashed worker becomes claimable after its lease.
      redis.call('ZADD', KEYS[1], now + tonumber(ARGV[5]), identifier)
      table.insert(claimed, identifier)
      table.insert(claimed, payload)
    end
  end
end
return claimed
"#;

const COMPLETE_DELAYED_OPERATION_SCRIPT: &str = r#"
if redis.call('GET', KEYS[3]) ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
"#;

const RETRY_DELAYED_OPERATION_SCRIPT: &str = r#"
if redis.call('GET', KEYS[3]) ~= ARGV[1] then
  return 0
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[3])
  redis.call('ZREM', KEYS[2], ARGV[2])
  return -1
end

local canonical = redis.call('GET', KEYS[4])
if canonical and canonical ~= ARGV[6] then
  return -2
end
if not canonical then
  redis.call('SET', KEYS[4], ARGV[6], 'PX', ARGV[3])
else
  redis.call('PEXPIRE', KEYS[4], ARGV[3])
end

local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
local delay = tonumber(ARGV[4])
local maximum = tonumber(ARGV[5])
local remaining = attempts
while remaining > 1 and delay < maximum do
  delay = math.min(delay * 2, maximum)
  remaining = remaining - 1
end
local redis_time = redis.call('TIME')
local now = redis_time[1] * 1000 + math.floor(redis_time[2] / 1000)
local due = now + delay

redis.call('HSET', KEYS[1], 'nextAttemptAtMs', tostring(due))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], due, ARGV[2])
redis.call('DEL', KEYS[3])
return attempts
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
    /// Decimal text used by Redis Lua because cjson numbers cannot represent every u64 exactly.
    #[serde(default)]
    pub chain_id_text: String,
    pub entry_point: String,
    pub user_operation: UserOperation,
    pub admitted: bool,
    #[serde(default)]
    pub next_receipt_check_at_ms: u64,
    pub block_hash: Option<String>,
    pub block_number: Option<String>,
    pub receipt: Option<Value>,
    pub event: Option<UserOperationEvent>,
    /// The last non-durable executor outcome, retained while the operation is queued so callers
    /// can distinguish a healthy queue from a retry that cannot currently make progress.
    #[serde(default)]
    pub last_executor_stage: Option<String>,
    #[serde(default)]
    pub last_executor_error: Option<String>,
    #[serde(default)]
    pub last_executor_attempt_at_ms: Option<u64>,
}

impl StoredUserOperation {
    pub fn rpc_status(&self) -> UserOperationStatus {
        let is_pending = matches!(
            self.status,
            UserOperationStatusKind::Queued | UserOperationStatusKind::NotSubmitted
        );
        UserOperationStatus {
            status: self.status,
            transaction_hash: self.transaction_hash.clone(),
            last_executor_stage: is_pending
                .then(|| self.last_executor_stage.clone())
                .flatten(),
            last_executor_error: is_pending
                .then(|| self.last_executor_error.clone())
                .flatten(),
            last_executor_attempt_at_ms: is_pending
                .then_some(self.last_executor_attempt_at_ms)
                .flatten(),
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

/// Lossless immutable copy of a routed Iggy message that was deferred for a future account nonce.
///
/// The source position is part of the identity, so producer retries at different Iggy offsets are
/// independently recoverable without allowing one payload to overwrite another.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayedUserOperation {
    pub schema_version: u32,
    pub user_operation_hash: String,
    pub chain_id: u64,
    pub entry_point: String,
    pub user_operation: Value,
    pub sender: String,
    pub lane: u8,
    pub stream: String,
    pub partition_id: u32,
    pub offset: u64,
}

#[derive(Clone, Debug)]
pub struct ClaimedDelayedUserOperation {
    pub identifier: String,
    pub operation: DelayedUserOperation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOperationEvent {
    pub user_operation_hash: String,
    pub success: bool,
    pub actual_gas_cost: String,
    pub actual_gas_used: String,
}

/// A fully signed outer transaction persisted before its first broadcast.
///
/// One intent may exist for a `(chain_id, lane)` pair. If a worker dies after broadcasting but
/// before updating UserOperation status, its successor loads and rebroadcasts this exact byte
/// sequence instead of allocating another nonce.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedBundleIntent {
    pub chain_id: u64,
    pub lane: u8,
    pub entry_point: String,
    pub raw_transaction: String,
    pub transaction_hash: String,
    pub nonce: u64,
    pub user_operation_hashes: Vec<String>,
}

/// A signed treasury transfer persisted before broadcast. Only one funding transaction may be
/// outstanding per chain, which serializes the treasury nonce across all relayer lanes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFundingIntent {
    pub chain_id: u64,
    pub relayer: String,
    pub amount_wei: u128,
    pub raw_transaction: String,
    pub transaction_hash: String,
    pub nonce: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MalformedDeadLetter {
    chain_id: u64,
    partition_id: u32,
    offset: u64,
    payload_hex: String,
    reason: String,
    user_operation_hash: Option<String>,
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
        self.create_queued_with_admission(operation, false).await
    }

    /// Recreates the one-hour query/status projection from a durable Iggy or delayed-inbox
    /// payload. This is SET-NX: it never overwrites a concurrent transition or an existing record.
    pub async fn restore_queued_from_durable_payload(
        &self,
        operation: QueuedUserOperation,
    ) -> Result<bool, UserOperationStatusStoreError> {
        self.create_queued_with_admission(operation, true).await
    }

    async fn create_queued_with_admission(
        &self,
        operation: QueuedUserOperation,
        admitted: bool,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let key = status_key(&operation.user_operation_hash);
        let record = queued_record(operation, admitted);
        let payload = serde_json::to_string(&record).map_err(|_| {
            UserOperationStatusStoreError("could not serialize UserOperation status")
        })?;
        let mut command = redis::cmd("SET");
        command
            .arg(key)
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

    /// Fetches lifecycle records with one Redis round trip while retaining caller order.
    pub async fn get_many(
        &self,
        user_operation_hashes: &[String],
    ) -> Result<Vec<Option<StoredUserOperation>>, UserOperationStatusStoreError> {
        if user_operation_hashes.is_empty() {
            return Ok(Vec::new());
        }

        let mut command = redis::cmd("MGET");
        for hash in user_operation_hashes {
            command.arg(status_key(hash));
        }
        let payloads: Vec<Option<String>> = self.query(command).await?;
        deserialize_stored_operations(payloads)
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

    /// Called by the Iggy consumer after a handleOps transaction has been accepted into the
    /// mempool. Every hash is indexed by that transaction so later receipt checks update the
    /// whole bundle together.
    pub async fn mark_bundle_submitted(
        &self,
        chain_id: u64,
        transaction_hash: &str,
        user_operation_hashes: &[String],
    ) -> Result<usize, UserOperationStatusStoreError> {
        if user_operation_hashes.is_empty() {
            return Ok(0);
        }

        let unique_hashes = user_operation_hashes
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();

        let mut command = redis::cmd("EVAL");
        command
            .arg(MARK_BUNDLE_SUBMITTED_SCRIPT)
            .arg(unique_hashes.len() + 1)
            .arg(bundle_key(chain_id, transaction_hash));
        for hash in &unique_hashes {
            command.arg(status_key(hash));
        }
        command.arg(transaction_hash).arg(chain_id);
        for hash in &unique_hashes {
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
        let (event_by_hash, outside_events) = partition_bundle_events(&hashes, events);
        for event in outside_events {
            tracing::warn!(
                user_operation_hash = %event.user_operation_hash,
                %transaction_hash,
                "ignoring UserOperationEvent outside the persisted bundle"
            );
        }

        for hash in hashes {
            let event = event_by_hash.get(hash.as_str()).copied();
            let status = if event.is_some_and(|event| event.success) {
                UserOperationStatusKind::Included
            } else {
                UserOperationStatusKind::Rejected
            };
            self.patch(
                &hash,
                receipt_patch(status, transaction_hash, &receipt, event),
            )
            .await?;
        }
        Ok(())
    }

    /// Acquires a cross-process lease. `token` must be unique per acquisition attempt and must
    /// be retained by the caller for renewal/release.
    pub async fn acquire_lease(
        &self,
        scope: &str,
        token: &str,
        ttl: Duration,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_lease_identity(scope, token)?;
        let ttl_ms = duration_millis(ttl)?;
        let mut command = redis::cmd("SET");
        command
            .arg(lease_key(scope))
            .arg(token)
            .arg("NX")
            .arg("PX")
            .arg(ttl_ms);
        let reply: Option<String> = self.query(command).await?;
        Ok(reply.is_some())
    }

    /// Extends a lease only when it is still owned by `token`.
    pub async fn renew_lease(
        &self,
        scope: &str,
        token: &str,
        ttl: Duration,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_lease_identity(scope, token)?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(RENEW_LEASE_SCRIPT)
            .arg(1)
            .arg(lease_key(scope))
            .arg(token)
            .arg(duration_millis(ttl)?);
        let renewed: i64 = self.query(command).await?;
        Ok(renewed == 1)
    }

    /// Releases a lease only when it is still owned by `token`.
    pub async fn release_lease(
        &self,
        scope: &str,
        token: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_lease_identity(scope, token)?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(RELEASE_LEASE_SCRIPT)
            .arg(1)
            .arg(lease_key(scope))
            .arg(token);
        let released: i64 = self.query(command).await?;
        Ok(released == 1)
    }

    /// Atomically stores the complete immutable queue envelope and schedules a retry. Repeated
    /// delivery of the same Iggy position is idempotent; a different payload at that position is
    /// rejected. Scheduling also invalidates an active claim, which fences a scheduler that just
    /// learned the nonce is still in the future from deleting the item on return.
    pub async fn defer_user_operation(
        &self,
        operation: &DelayedUserOperation,
        ttl: Duration,
    ) -> Result<u32, UserOperationStatusStoreError> {
        validate_delayed_operation(operation)?;
        let identifier = delayed_operation_identifier(operation);
        let canonical_payload = canonical_delayed_payload(operation)?;
        let payload = serde_json::to_string(operation).map_err(|_| {
            UserOperationStatusStoreError("could not serialize delayed UserOperation")
        })?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(SAVE_DELAYED_OPERATION_SCRIPT)
            .arg(4)
            .arg(delayed_operation_payload_key(
                &operation.user_operation_hash,
            ))
            .arg(delayed_operation_key(&identifier))
            .arg(DELAYED_OPERATION_SCHEDULE_KEY)
            .arg(delayed_operation_claim_key(&identifier))
            .arg(canonical_payload)
            .arg(payload)
            .arg(&identifier)
            .arg(duration_millis(ttl)?)
            .arg(DELAYED_RETRY_BASE_MS)
            .arg(DELAYED_RETRY_MAX_MS);
        let attempts: i64 = self.query(command).await?;
        if attempts < 0 {
            return Err(UserOperationStatusStoreError(
                "delayed UserOperation position has a conflicting payload",
            ));
        }
        u32::try_from(attempts).map_err(|_| {
            UserOperationStatusStoreError("delayed UserOperation retry count overflowed")
        })
    }

    /// Atomically claims a due page across all relay replicas. Claimed schedule scores move to
    /// the claim deadline so crashed workers recover automatically without starving later items.
    pub async fn claim_due_user_operations(
        &self,
        token: &str,
        limit: usize,
        claim_ttl: Duration,
    ) -> Result<Vec<ClaimedDelayedUserOperation>, UserOperationStatusStoreError> {
        validate_lease_identity("delayed-user-operation", token)?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = u32::try_from(limit).map_err(|_| {
            UserOperationStatusStoreError("delayed UserOperation claim limit is too large")
        })?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(CLAIM_DELAYED_OPERATIONS_SCRIPT)
            .arg(1)
            .arg(DELAYED_OPERATION_SCHEDULE_KEY)
            .arg(token)
            .arg(limit)
            .arg(DELAYED_OPERATION_KEY_PREFIX)
            .arg(DELAYED_OPERATION_CLAIM_KEY_PREFIX)
            .arg(duration_millis(claim_ttl)?);
        let payloads: Vec<String> = self.query(command).await?;
        deserialize_claimed_delayed_operations(payloads)
    }

    /// Deletes a delayed item only while `token` still owns its claim. `false` is expected when
    /// execution re-deferred a future nonce and deliberately invalidated this claim.
    pub async fn complete_delayed_user_operation(
        &self,
        identifier: &str,
        token: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_delayed_identifier(identifier)?;
        validate_lease_identity("delayed-user-operation", token)?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(COMPLETE_DELAYED_OPERATION_SCRIPT)
            .arg(3)
            .arg(delayed_operation_key(identifier))
            .arg(DELAYED_OPERATION_SCHEDULE_KEY)
            .arg(delayed_operation_claim_key(identifier))
            .arg(token)
            .arg(identifier);
        let completed: i64 = self.query(command).await?;
        Ok(completed == 1)
    }

    /// Releases an owned claim back to the delayed schedule with bounded exponential backoff.
    /// The immutable payload TTL is refreshed so a live retry cannot expire underneath a worker.
    pub async fn retry_delayed_user_operation(
        &self,
        operation: &DelayedUserOperation,
        token: &str,
        ttl: Duration,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_delayed_operation(operation)?;
        let identifier = delayed_operation_identifier(operation);
        validate_delayed_identifier(&identifier)?;
        validate_lease_identity("delayed-user-operation", token)?;
        let canonical_payload = canonical_delayed_payload(operation)?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(RETRY_DELAYED_OPERATION_SCRIPT)
            .arg(4)
            .arg(delayed_operation_key(&identifier))
            .arg(DELAYED_OPERATION_SCHEDULE_KEY)
            .arg(delayed_operation_claim_key(&identifier))
            .arg(delayed_operation_payload_key(
                &operation.user_operation_hash,
            ))
            .arg(token)
            .arg(&identifier)
            .arg(duration_millis(ttl)?)
            .arg(DELAYED_RETRY_BASE_MS)
            .arg(DELAYED_RETRY_MAX_MS)
            .arg(canonical_payload);
        let retried: i64 = self.query(command).await?;
        if retried == -2 {
            return Err(UserOperationStatusStoreError(
                "delayed UserOperation hash has a conflicting payload",
            ));
        }
        Ok(retried > 0)
    }

    /// Persists an outer transaction before broadcast. A different outstanding intent for the
    /// same chain/lane is never overwritten.
    pub async fn save_prepared_bundle_intent(
        &self,
        intent: &PreparedBundleIntent,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_prepared_bundle_intent(intent)?;
        let payload = serde_json::to_string(intent)
            .map_err(|_| UserOperationStatusStoreError("could not serialize prepared bundle"))?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(SAVE_PREPARED_BUNDLE_SCRIPT)
            .arg(2)
            .arg(prepared_bundle_key(intent.chain_id, intent.lane))
            .arg(PREPARED_BUNDLE_INDEX_KEY)
            .arg(payload);
        let stored: i64 = self.query(command).await?;
        Ok(stored == 1)
    }

    /// Loads the outstanding transaction that must be reconciled/rebroadcast before this lane
    /// may allocate another nonce.
    pub async fn get_prepared_bundle_intent(
        &self,
        chain_id: u64,
        lane: u8,
    ) -> Result<Option<PreparedBundleIntent>, UserOperationStatusStoreError> {
        let mut command = redis::cmd("GET");
        command.arg(prepared_bundle_key(chain_id, lane));
        let payload: Option<String> = self.query(command).await?;
        let intent = payload
            .map(|payload| {
                serde_json::from_str::<PreparedBundleIntent>(&payload)
                    .map_err(|_| UserOperationStatusStoreError("stored prepared bundle is invalid"))
            })
            .transpose()?;
        if intent
            .as_ref()
            .is_some_and(|intent| intent.chain_id != chain_id || intent.lane != lane)
        {
            return Err(UserOperationStatusStoreError(
                "stored prepared bundle has the wrong scope",
            ));
        }
        Ok(intent)
    }

    /// Deletes an intent only if the transaction hash still matches, protecting a newer lane
    /// intent from a delayed completion task.
    pub async fn clear_prepared_bundle_intent(
        &self,
        chain_id: u64,
        lane: u8,
        transaction_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(CLEAR_PREPARED_BUNDLE_SCRIPT)
            .arg(2)
            .arg(prepared_bundle_key(chain_id, lane))
            .arg(PREPARED_BUNDLE_INDEX_KEY)
            .arg(transaction_hash);
        let cleared: i64 = self.query(command).await?;
        Ok(cleared == 1)
    }

    /// Lists every live prepared bundle across discovered chains. The Redis-side scan repairs
    /// stale index entries if an operator explicitly removed a payload.
    pub async fn list_prepared_bundle_intents(
        &self,
    ) -> Result<Vec<PreparedBundleIntent>, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(LIST_PREPARED_BUNDLES_SCRIPT)
            .arg(1)
            .arg(PREPARED_BUNDLE_INDEX_KEY);
        let payloads: Vec<String> = self.query(command).await?;
        deserialize_prepared_bundle_intents(payloads)
    }

    /// Atomically reserves the per-chain daily top-up budget and writes the signed funding
    /// outbox record. Keeping both effects in one Lua transaction eliminates the crash window in
    /// which budget could be consumed without retaining a transaction that can be replayed.
    ///
    /// Returns `false` when another funding intent already owns this chain or when the daily cap
    /// would be exceeded. Callers already holding the chain treasury lease can distinguish those
    /// cases by loading the current intent.
    pub async fn reserve_and_save_prepared_funding_intent(
        &self,
        intent: &PreparedFundingIntent,
        daily_limit: u128,
        budget_ttl: Duration,
    ) -> Result<bool, UserOperationStatusStoreError> {
        validate_prepared_funding_intent(intent)?;
        if daily_limit == 0 {
            return Err(UserOperationStatusStoreError(
                "daily top-up limit must be greater than zero",
            ));
        }
        let payload = serde_json::to_string(intent)
            .map_err(|_| UserOperationStatusStoreError("could not serialize prepared funding"))?;
        let mut command = redis::cmd("EVAL");
        command
            .arg(RESERVE_AND_SAVE_FUNDING_SCRIPT)
            .arg(2)
            .arg(prepared_funding_key(intent.chain_id))
            .arg(top_up_budget_key(intent.chain_id))
            .arg(intent.amount_wei.to_string())
            .arg(daily_limit.to_string())
            .arg(duration_millis(budget_ttl)?)
            .arg(payload);
        let reserved: i64 = self.query(command).await?;
        Ok(reserved == 1)
    }

    pub async fn get_prepared_funding_intent(
        &self,
        chain_id: u64,
    ) -> Result<Option<PreparedFundingIntent>, UserOperationStatusStoreError> {
        let mut command = redis::cmd("GET");
        command.arg(prepared_funding_key(chain_id));
        let payload: Option<String> = self.query(command).await?;
        let intent = payload
            .map(|payload| {
                serde_json::from_str::<PreparedFundingIntent>(&payload).map_err(|_| {
                    UserOperationStatusStoreError("stored prepared funding is invalid")
                })
            })
            .transpose()?;
        if intent
            .as_ref()
            .is_some_and(|intent| intent.chain_id != chain_id)
        {
            return Err(UserOperationStatusStoreError(
                "stored prepared funding has the wrong chain",
            ));
        }
        Ok(intent)
    }

    /// Deletes a funding intent only if its transaction hash still matches.
    pub async fn clear_prepared_funding_intent(
        &self,
        chain_id: u64,
        transaction_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(CLEAR_PREPARED_FUNDING_SCRIPT)
            .arg(1)
            .arg(prepared_funding_key(chain_id))
            .arg(transaction_hash);
        let cleared: i64 = self.query(command).await?;
        Ok(cleared == 1)
    }

    /// Removes a funding outbox that is proven to have reverted and returns its transfer amount
    /// to the chain's rolling budget in the same Redis transaction.
    pub async fn clear_and_refund_prepared_funding_intent(
        &self,
        chain_id: u64,
        transaction_hash: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let mut command = redis::cmd("EVAL");
        command
            .arg(CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT)
            .arg(2)
            .arg(prepared_funding_key(chain_id))
            .arg(top_up_budget_key(chain_id))
            .arg(transaction_hash);
        let cleared: i64 = self.query(command).await?;
        Ok(cleared == 1)
    }

    /// Durably records a malformed Iggy message. The queue position is the idempotency key, so a
    /// redelivery returns `false` without duplicating the dead letter.
    #[allow(
        clippy::too_many_arguments,
        reason = "The arguments intentionally mirror the lossless malformed queue envelope."
    )]
    pub async fn save_malformed_dead_letter(
        &self,
        chain_id: u64,
        partition_id: u32,
        offset: u64,
        payload: &[u8],
        reason: &str,
        user_operation_hash: Option<&str>,
        ttl: Duration,
    ) -> Result<bool, UserOperationStatusStoreError> {
        if reason.is_empty() {
            return Err(UserOperationStatusStoreError(
                "malformed dead-letter reason must not be empty",
            ));
        }
        let dead_letter = malformed_dead_letter(
            chain_id,
            partition_id,
            offset,
            payload,
            reason,
            user_operation_hash,
        );
        let payload = serde_json::to_string(&dead_letter)
            .map_err(|_| UserOperationStatusStoreError("could not serialize malformed message"))?;
        let mut command = redis::cmd("SET");
        command
            .arg(malformed_dead_letter_key(chain_id, partition_id, offset))
            .arg(payload)
            .arg("NX")
            .arg("PX")
            .arg(duration_millis(ttl)?);
        let reply: Option<String> = self.query(command).await?;
        Ok(reply.is_some())
    }

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

    /// Records a retryable executor outcome without changing the UserOperation lifecycle. The
    /// diagnostic is intentionally bounded because trusted RPC error bodies are external input
    /// and clients poll this record directly.
    pub async fn record_executor_deferred(
        &self,
        user_operation_hash: &str,
        stage: &str,
        reason: &str,
    ) -> Result<bool, UserOperationStatusStoreError> {
        let attempted_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        self.patch(
            user_operation_hash,
            json!({
                "lastExecutorStage": truncate_diagnostic(stage, 64),
                "lastExecutorError": truncate_diagnostic(reason, 512),
                "lastExecutorAttemptAtMs": attempted_at_ms,
            }),
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

fn queued_record(operation: QueuedUserOperation, admitted: bool) -> StoredUserOperation {
    StoredUserOperation {
        status: UserOperationStatusKind::Queued,
        transaction_hash: None,
        chain_id: operation.chain_id,
        chain_id_text: operation.chain_id.to_string(),
        entry_point: operation.entry_point,
        user_operation: operation.user_operation,
        admitted,
        next_receipt_check_at_ms: 0,
        block_hash: None,
        block_number: None,
        receipt: None,
        event: None,
        last_executor_stage: None,
        last_executor_error: None,
        last_executor_attempt_at_ms: None,
    }
}

fn truncate_diagnostic(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let end = value
        .char_indices()
        .take_while(|(index, character)| {
            index.saturating_add(character.len_utf8()) <= limit.saturating_sub(3)
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    format!("{}...", &value[..end])
}

fn status_key(user_operation_hash: &str) -> String {
    format!("{STATUS_KEY_PREFIX}{user_operation_hash}")
}

fn bundle_key(chain_id: u64, transaction_hash: &str) -> String {
    format!("{BUNDLE_KEY_PREFIX}{chain_id}:{transaction_hash}")
}

fn lease_key(scope: &str) -> String {
    format!("{LEASE_KEY_PREFIX}{scope}")
}

fn prepared_bundle_key(chain_id: u64, lane: u8) -> String {
    format!("{PREPARED_BUNDLE_KEY_PREFIX}{chain_id}:{lane}")
}

fn prepared_funding_key(chain_id: u64) -> String {
    format!("{PREPARED_FUNDING_KEY_PREFIX}{chain_id}")
}

fn top_up_budget_key(chain_id: u64) -> String {
    format!("{TOP_UP_BUDGET_KEY_PREFIX}{chain_id}")
}

fn malformed_dead_letter_key(chain_id: u64, partition_id: u32, offset: u64) -> String {
    format!("{MALFORMED_DEAD_LETTER_KEY_PREFIX}{chain_id}:{partition_id}:{offset}")
}

fn delayed_operation_payload_key(user_operation_hash: &str) -> String {
    format!(
        "{DELAYED_OPERATION_PAYLOAD_KEY_PREFIX}{}",
        user_operation_hash.to_ascii_lowercase()
    )
}

fn delayed_operation_identifier(operation: &DelayedUserOperation) -> String {
    format!(
        "{}:{}:{}:{}",
        operation.chain_id,
        operation.partition_id,
        operation.offset,
        operation.user_operation_hash.to_ascii_lowercase()
    )
}

fn delayed_operation_key(identifier: &str) -> String {
    format!("{DELAYED_OPERATION_KEY_PREFIX}{identifier}")
}

fn delayed_operation_claim_key(identifier: &str) -> String {
    format!("{DELAYED_OPERATION_CLAIM_KEY_PREFIX}{identifier}")
}

fn canonical_delayed_payload(
    operation: &DelayedUserOperation,
) -> Result<String, UserOperationStatusStoreError> {
    serde_json::to_string(&json!({
        "schemaVersion": operation.schema_version,
        "userOperationHash": operation.user_operation_hash.to_ascii_lowercase(),
        "chainId": operation.chain_id,
        "entryPoint": operation.entry_point.to_ascii_lowercase(),
        "userOperation": operation.user_operation,
        "sender": operation.sender.to_ascii_lowercase(),
        "lane": operation.lane,
    }))
    .map_err(|_| UserOperationStatusStoreError("could not serialize delayed UserOperation"))
}

fn validate_delayed_operation(
    operation: &DelayedUserOperation,
) -> Result<(), UserOperationStatusStoreError> {
    if operation.schema_version != 1
        || operation.entry_point.is_empty()
        || operation.sender.is_empty()
        || operation.user_operation.is_null()
        || operation.stream != format!("chain-{}", operation.chain_id)
    {
        return Err(UserOperationStatusStoreError(
            "delayed UserOperation envelope is invalid",
        ));
    }
    let hash = operation
        .user_operation_hash
        .strip_prefix("0x")
        .or_else(|| operation.user_operation_hash.strip_prefix("0X"))
        .ok_or(UserOperationStatusStoreError(
            "delayed UserOperation hash is invalid",
        ))?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(UserOperationStatusStoreError(
            "delayed UserOperation hash is invalid",
        ));
    }
    Ok(())
}

fn validate_delayed_identifier(identifier: &str) -> Result<(), UserOperationStatusStoreError> {
    if identifier.is_empty()
        || identifier.len() > 192
        || !identifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b':' || byte == b'x')
    {
        return Err(UserOperationStatusStoreError(
            "delayed UserOperation identifier is invalid",
        ));
    }
    Ok(())
}

fn duration_millis(ttl: Duration) -> Result<u64, UserOperationStatusStoreError> {
    let milliseconds = i64::try_from(ttl.as_millis())
        .map_err(|_| UserOperationStatusStoreError("Redis TTL is too large"))?;
    if milliseconds == 0 {
        return Err(UserOperationStatusStoreError(
            "Redis TTL must be at least one millisecond",
        ));
    }
    Ok(milliseconds as u64)
}

fn deserialize_stored_operations(
    payloads: Vec<Option<String>>,
) -> Result<Vec<Option<StoredUserOperation>>, UserOperationStatusStoreError> {
    payloads
        .into_iter()
        .map(|payload| {
            payload
                .map(|payload| {
                    serde_json::from_str(&payload).map_err(|_| {
                        UserOperationStatusStoreError("stored UserOperation status is invalid")
                    })
                })
                .transpose()
        })
        .collect()
}

fn deserialize_prepared_bundle_intents(
    indexed_payloads: Vec<String>,
) -> Result<Vec<PreparedBundleIntent>, UserOperationStatusStoreError> {
    if !indexed_payloads.len().is_multiple_of(2) {
        return Err(UserOperationStatusStoreError(
            "prepared bundle index response is invalid",
        ));
    }
    let mut intents = Vec::with_capacity(indexed_payloads.len() / 2);
    let mut values = indexed_payloads.into_iter();
    while let (Some(key), Some(payload)) = (values.next(), values.next()) {
        let intent = serde_json::from_str::<PreparedBundleIntent>(&payload)
            .map_err(|_| UserOperationStatusStoreError("stored prepared bundle is invalid"))?;
        if prepared_bundle_key(intent.chain_id, intent.lane) != key {
            return Err(UserOperationStatusStoreError(
                "stored prepared bundle has the wrong scope",
            ));
        }
        intents.push(intent);
    }
    intents.sort_by_key(|intent| (intent.chain_id, intent.lane, intent.nonce));
    Ok(intents)
}

fn deserialize_claimed_delayed_operations(
    indexed_payloads: Vec<String>,
) -> Result<Vec<ClaimedDelayedUserOperation>, UserOperationStatusStoreError> {
    if !indexed_payloads.len().is_multiple_of(2) {
        return Err(UserOperationStatusStoreError(
            "delayed UserOperation claim response is invalid",
        ));
    }
    let mut claimed = Vec::with_capacity(indexed_payloads.len() / 2);
    let mut values = indexed_payloads.into_iter();
    while let (Some(identifier), Some(payload)) = (values.next(), values.next()) {
        validate_delayed_identifier(&identifier)?;
        let operation = serde_json::from_str::<DelayedUserOperation>(&payload).map_err(|_| {
            UserOperationStatusStoreError("stored delayed UserOperation is invalid")
        })?;
        validate_delayed_operation(&operation)?;
        if delayed_operation_identifier(&operation) != identifier {
            return Err(UserOperationStatusStoreError(
                "stored delayed UserOperation has the wrong source position",
            ));
        }
        claimed.push(ClaimedDelayedUserOperation {
            identifier,
            operation,
        });
    }
    Ok(claimed)
}

fn validate_lease_identity(scope: &str, token: &str) -> Result<(), UserOperationStatusStoreError> {
    if scope.is_empty() {
        return Err(UserOperationStatusStoreError(
            "Redis lease scope must not be empty",
        ));
    }
    if token.is_empty() {
        return Err(UserOperationStatusStoreError(
            "Redis lease token must not be empty",
        ));
    }
    Ok(())
}

fn validate_prepared_bundle_intent(
    intent: &PreparedBundleIntent,
) -> Result<(), UserOperationStatusStoreError> {
    if intent.entry_point.is_empty()
        || intent.raw_transaction.is_empty()
        || intent.transaction_hash.is_empty()
        || intent.user_operation_hashes.is_empty()
    {
        return Err(UserOperationStatusStoreError(
            "prepared bundle fields must not be empty",
        ));
    }
    Ok(())
}

fn validate_prepared_funding_intent(
    intent: &PreparedFundingIntent,
) -> Result<(), UserOperationStatusStoreError> {
    if intent.relayer.is_empty()
        || intent.amount_wei == 0
        || intent.raw_transaction.is_empty()
        || intent.transaction_hash.is_empty()
    {
        return Err(UserOperationStatusStoreError(
            "prepared funding fields must not be empty",
        ));
    }
    Ok(())
}

fn malformed_dead_letter(
    chain_id: u64,
    partition_id: u32,
    offset: u64,
    payload: &[u8],
    reason: &str,
    user_operation_hash: Option<&str>,
) -> MalformedDeadLetter {
    MalformedDeadLetter {
        chain_id,
        partition_id,
        offset,
        payload_hex: format!("0x{}", hex::encode(payload)),
        reason: reason.to_owned(),
        user_operation_hash: user_operation_hash.map(str::to_owned),
    }
}

fn partition_bundle_events<'a>(
    hashes: &[String],
    events: &'a [UserOperationEvent],
) -> (
    HashMap<&'a str, &'a UserOperationEvent>,
    Vec<&'a UserOperationEvent>,
) {
    let membership = hashes.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut included = HashMap::with_capacity(events.len());
    let mut outside = Vec::new();
    for event in events {
        if membership.contains(event.user_operation_hash.as_str()) {
            included.insert(event.user_operation_hash.as_str(), event);
        } else {
            outside.push(event);
        }
    }
    (included, outside)
}

#[cfg(test)]
fn transition_is_allowed(current: UserOperationStatusKind, next: UserOperationStatusKind) -> bool {
    use UserOperationStatusKind::{Failed, Included, NotSubmitted, Queued, Rejected, Submitted};

    current == next
        || matches!(
            (current, next),
            (Queued, NotSubmitted | Submitted | Rejected | Failed)
                | (NotSubmitted, Submitted | Rejected | Failed)
                | (Submitted, Included | Rejected | Failed)
        )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::{
        CLAIM_DELAYED_OPERATIONS_SCRIPT, CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT,
        CLEAR_PREPARED_BUNDLE_SCRIPT, CLEAR_PREPARED_FUNDING_SCRIPT,
        COMPLETE_DELAYED_OPERATION_SCRIPT, DELAYED_OPERATION_SCHEDULE_KEY, DelayedUserOperation,
        LIST_PREPARED_BUNDLES_SCRIPT, MARK_BUNDLE_SUBMITTED_SCRIPT, PATCH_RECORD_SCRIPT,
        PREPARED_BUNDLE_INDEX_KEY, PreparedBundleIntent, PreparedFundingIntent,
        RELEASE_LEASE_SCRIPT, RENEW_LEASE_SCRIPT, RESERVE_AND_SAVE_FUNDING_SCRIPT,
        RETRY_DELAYED_OPERATION_SCRIPT, SAVE_DELAYED_OPERATION_SCRIPT, SAVE_PREPARED_BUNDLE_SCRIPT,
        UserOperationEvent, UserOperationStatusKind, canonical_delayed_payload,
        delayed_operation_identifier, deserialize_claimed_delayed_operations,
        deserialize_prepared_bundle_intents, deserialize_stored_operations, duration_millis,
        lease_key, malformed_dead_letter, malformed_dead_letter_key, partition_bundle_events,
        prepared_bundle_key, prepared_funding_key, top_up_budget_key, transition_is_allowed,
        truncate_diagnostic, validate_lease_identity, validate_prepared_bundle_intent,
        validate_prepared_funding_intent,
    };

    #[test]
    fn status_transition_matrix_is_monotonic() {
        use UserOperationStatusKind::{
            Failed, Included, NotFound, NotSubmitted, Queued, Rejected, Submitted,
        };

        assert!(transition_is_allowed(Queued, NotSubmitted));
        assert!(transition_is_allowed(Queued, Submitted));
        assert!(transition_is_allowed(Queued, Rejected));
        assert!(transition_is_allowed(Queued, Failed));
        assert!(transition_is_allowed(NotSubmitted, Submitted));
        assert!(transition_is_allowed(NotSubmitted, Rejected));
        assert!(transition_is_allowed(NotSubmitted, Failed));
        assert!(transition_is_allowed(Submitted, Included));
        assert!(transition_is_allowed(Submitted, Rejected));
        assert!(transition_is_allowed(Submitted, Failed));

        for terminal in [Rejected, Included, Failed] {
            for next in [
                NotFound,
                Queued,
                NotSubmitted,
                Submitted,
                Rejected,
                Included,
                Failed,
            ] {
                assert_eq!(
                    transition_is_allowed(terminal, next),
                    terminal == next,
                    "terminal {terminal:?} must not transition to {next:?}"
                );
            }
        }
        assert!(!transition_is_allowed(Submitted, Queued));
        assert!(!transition_is_allowed(NotSubmitted, Queued));
        assert!(!transition_is_allowed(Queued, Included));
    }

    #[test]
    fn patch_lua_has_the_same_terminal_guards() {
        assert!(PATCH_RECORD_SCRIPT.contains("next_status ~= current_status"));
        assert!(PATCH_RECORD_SCRIPT.contains("queued = {not_submitted = true"));
        assert!(PATCH_RECORD_SCRIPT.contains("not_submitted = {submitted = true"));
        assert!(PATCH_RECORD_SCRIPT.contains("submitted = {rejected = true, included = true"));
        assert!(!PATCH_RECORD_SCRIPT.contains("included = {"));
        assert!(!PATCH_RECORD_SCRIPT.contains("rejected = {"));
        assert!(!PATCH_RECORD_SCRIPT.contains("failed = {"));
    }

    #[test]
    fn executor_diagnostics_are_bounded_without_splitting_utf8() {
        assert_eq!(truncate_diagnostic("retry", 8), "retry");
        assert_eq!(truncate_diagnostic("abcdef", 5), "ab...");
        assert_eq!(truncate_diagnostic("你好世界", 7), "你...");
    }

    #[test]
    fn submitted_lua_indexes_only_new_or_idempotent_same_transaction_members() {
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("current_status == 'queued'"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("current_status == 'not_submitted'"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("current_status == 'submitted'"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("record['transactionHash'] == ARGV[1]"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("same_chain"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("record['chainIdText']"));
        assert!(!MARK_BUNDLE_SUBMITTED_SCRIPT.contains("tonumber(record['chainId'])"));
        assert!(MARK_BUNDLE_SUBMITTED_SCRIPT.contains("if should_index then"));
    }

    #[test]
    fn bundle_events_are_restricted_to_persisted_membership() {
        let hashes = vec!["0x01".to_owned(), "0x02".to_owned()];
        let events = vec![
            UserOperationEvent {
                user_operation_hash: "0x01".into(),
                success: true,
                actual_gas_cost: "0x1".into(),
                actual_gas_used: "0x2".into(),
            },
            UserOperationEvent {
                user_operation_hash: "0xoutside".into(),
                success: true,
                actual_gas_cost: "0x3".into(),
                actual_gas_used: "0x4".into(),
            },
        ];

        let (included, outside) = partition_bundle_events(&hashes, &events);
        assert_eq!(included.len(), 1);
        assert!(included.contains_key("0x01"));
        assert!(!included.contains_key("0xoutside"));
        assert_eq!(outside.len(), 1);
        assert_eq!(outside[0].user_operation_hash, "0xoutside");
    }

    #[test]
    fn lease_scripts_compare_the_owner_token_before_mutation() {
        for script in [RENEW_LEASE_SCRIPT, RELEASE_LEASE_SCRIPT] {
            assert!(script.contains("redis.call('GET', KEYS[1]) ~= ARGV[1]"));
            assert!(script.contains("return 0"));
        }
        assert!(RENEW_LEASE_SCRIPT.contains("PEXPIRE"));
        assert!(RELEASE_LEASE_SCRIPT.contains("DEL"));
        assert_eq!(
            lease_key("executor:42161:3"),
            "vela:relay:lease:executor:42161:3"
        );
        assert!(validate_lease_identity("executor:1:0", "owner-token").is_ok());
        assert!(validate_lease_identity("", "owner-token").is_err());
        assert!(validate_lease_identity("executor:1:0", "").is_err());
        assert_eq!(duration_millis(Duration::from_millis(1)).unwrap(), 1);
        assert!(duration_millis(Duration::from_nanos(999_999)).is_err());
    }

    #[test]
    fn prepared_bundle_contract_is_scoped_and_compare_deleted() {
        let intent = PreparedBundleIntent {
            chain_id: 42161,
            lane: 3,
            entry_point: "0xentrypoint".into(),
            raw_transaction: "0x02aabb".into(),
            transaction_hash: "0xtransaction".into(),
            nonce: 42,
            user_operation_hashes: vec!["0xuserop".into()],
        };

        assert!(validate_prepared_bundle_intent(&intent).is_ok());
        assert_eq!(
            prepared_bundle_key(intent.chain_id, intent.lane),
            "vela:relay:prepared-bundle:42161:3"
        );
        let encoded = serde_json::to_string(&intent).unwrap();
        assert!(encoded.contains("\"rawTransaction\""));
        assert!(encoded.contains("\"entryPoint\""));
        assert_eq!(
            serde_json::from_str::<PreparedBundleIntent>(&encoded).unwrap(),
            intent
        );
        assert!(CLEAR_PREPARED_BUNDLE_SCRIPT.contains("intent['transactionHash'] ~= ARGV[1]"));
        assert!(CLEAR_PREPARED_BUNDLE_SCRIPT.contains("redis.call('DEL', KEYS[1])"));
        assert!(CLEAR_PREPARED_BUNDLE_SCRIPT.contains("redis.call('SREM', KEYS[2], KEYS[1])"));
        assert!(SAVE_PREPARED_BUNDLE_SCRIPT.contains("'SET', KEYS[1], ARGV[1], 'NX'"));
        assert!(!SAVE_PREPARED_BUNDLE_SCRIPT.contains("'PX'"));
        assert!(!SAVE_PREPARED_BUNDLE_SCRIPT.contains("EXPIRE"));
        assert!(SAVE_PREPARED_BUNDLE_SCRIPT.contains("'SADD', KEYS[2], KEYS[1]"));
        assert!(LIST_PREPARED_BUNDLES_SCRIPT.contains("'SMEMBERS', KEYS[1]"));
        assert!(LIST_PREPARED_BUNDLES_SCRIPT.contains("table.insert(result, key)"));
        assert!(LIST_PREPARED_BUNDLES_SCRIPT.contains("'SREM', KEYS[1], key"));
        assert_eq!(
            PREPARED_BUNDLE_INDEX_KEY,
            "vela:relay:prepared-bundle-index"
        );
    }

    #[test]
    fn mget_deserialization_fails_the_whole_batch_on_one_corrupt_record() {
        assert!(deserialize_stored_operations(vec![None, Some("not-json".into())]).is_err());
    }

    #[test]
    fn prepared_bundle_listing_is_sorted_and_fails_on_corruption() {
        let intent = |chain_id, lane, nonce| PreparedBundleIntent {
            chain_id,
            lane,
            entry_point: "0xentrypoint".into(),
            raw_transaction: "0x02aabb".into(),
            transaction_hash: format!("0x{chain_id:x}{lane:x}{nonce:x}"),
            nonce,
            user_operation_hashes: vec!["0xuserop".into()],
        };
        let payloads = [intent(10, 2, 4), intent(1, 9, 3), intent(1, 1, 8)]
            .into_iter()
            .flat_map(|intent| {
                [
                    prepared_bundle_key(intent.chain_id, intent.lane),
                    serde_json::to_string(&intent).unwrap(),
                ]
            })
            .collect();
        let listed = deserialize_prepared_bundle_intents(payloads).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|intent| (intent.chain_id, intent.lane, intent.nonce))
                .collect::<Vec<_>>(),
            vec![(1, 1, 8), (1, 9, 3), (10, 2, 4)]
        );
        assert!(
            deserialize_prepared_bundle_intents(vec![prepared_bundle_key(1, 0), "bad-json".into()])
                .is_err()
        );
        let wrong_scope = intent(1, 0, 1);
        assert!(
            deserialize_prepared_bundle_intents(vec![
                prepared_bundle_key(2, 0),
                serde_json::to_string(&wrong_scope).unwrap(),
            ])
            .is_err()
        );
    }

    #[test]
    fn prepared_funding_is_chain_scoped_and_compare_deleted() {
        let intent = PreparedFundingIntent {
            chain_id: 42161,
            relayer: "0xrelayer".into(),
            amount_wei: 1_000_000_000_000_000,
            raw_transaction: "0x02aabb".into(),
            transaction_hash: "0xfunding".into(),
            nonce: 9,
        };

        assert!(validate_prepared_funding_intent(&intent).is_ok());
        assert_eq!(
            prepared_funding_key(intent.chain_id),
            "vela:relay:prepared-funding:42161"
        );
        let encoded = serde_json::to_string(&intent).unwrap();
        assert_eq!(
            serde_json::from_str::<PreparedFundingIntent>(&encoded).unwrap(),
            intent
        );
        assert!(CLEAR_PREPARED_FUNDING_SCRIPT.contains("intent['transactionHash'] ~= ARGV[1]"));
        assert!(
            CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT
                .contains("intent['transactionHash'] ~= ARGV[1]")
        );
        assert!(CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT.contains("'KEEPTTL'"));
        assert!(!CLEAR_AND_REFUND_PREPARED_FUNDING_SCRIPT.contains("tonumber"));
        assert!(RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("local function decimal_add"));
        assert!(RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("decimal_greater(total, ARGV[2])"));
        assert!(RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("'SET', KEYS[1], ARGV[4], 'NX'"));
        assert!(!RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("ARGV[5]"));
        assert!(RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("'SET', KEYS[2], total, 'KEEPTTL'"));
        assert!(!RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("INCRBY"));
        assert!(!RESERVE_AND_SAVE_FUNDING_SCRIPT.contains("tonumber"));
        assert_eq!(top_up_budget_key(42161), "vela:relay:top-up-budget:42161");
    }

    #[test]
    fn delayed_inbox_keeps_payload_immutable_and_claims_token_fenced() {
        let operation = DelayedUserOperation {
            schema_version: 1,
            user_operation_hash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            chain_id: 42161,
            entry_point: "0x0000000071727de22e5e9d8baf0edac6f37da032".into(),
            user_operation: json!({
                "sender": "0x1111111111111111111111111111111111111111",
                "signature": "0x1234"
            }),
            sender: "0x1111111111111111111111111111111111111111".into(),
            lane: 1,
            stream: "chain-42161".into(),
            partition_id: 0,
            offset: 99,
        };
        let identifier = delayed_operation_identifier(&operation);
        assert_eq!(
            identifier,
            "42161:0:99:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        let mut duplicate_source = operation.clone();
        duplicate_source.offset = 100;
        assert_eq!(
            canonical_delayed_payload(&operation).unwrap(),
            canonical_delayed_payload(&duplicate_source).unwrap()
        );
        duplicate_source.user_operation["signature"] = json!("0x5678");
        assert_ne!(
            canonical_delayed_payload(&operation).unwrap(),
            canonical_delayed_payload(&duplicate_source).unwrap()
        );

        let decoded = deserialize_claimed_delayed_operations(vec![
            identifier.clone(),
            serde_json::to_string(&operation).unwrap(),
        ])
        .unwrap();
        assert_eq!(decoded[0].identifier, identifier);
        assert_eq!(decoded[0].operation, operation);

        assert!(SAVE_DELAYED_OPERATION_SCRIPT.contains("canonical ~= ARGV[1]"));
        assert!(SAVE_DELAYED_OPERATION_SCRIPT.contains("existing ~= ARGV[2]"));
        assert!(SAVE_DELAYED_OPERATION_SCRIPT.contains("'ZADD', KEYS[3], due"));
        assert!(CLAIM_DELAYED_OPERATIONS_SCRIPT.contains("'SET', claim_key, ARGV[1], 'NX', 'PX'"));
        assert!(CLAIM_DELAYED_OPERATIONS_SCRIPT.contains("now + tonumber(ARGV[5])"));
        for script in [
            COMPLETE_DELAYED_OPERATION_SCRIPT,
            RETRY_DELAYED_OPERATION_SCRIPT,
        ] {
            assert!(script.contains("redis.call('GET', KEYS[3]) ~= ARGV[1]"));
        }
        assert!(RETRY_DELAYED_OPERATION_SCRIPT.contains("redis.call('PEXPIRE', KEYS[4], ARGV[3])"));
        assert!(RETRY_DELAYED_OPERATION_SCRIPT.contains("canonical ~= ARGV[6]"));
        assert_eq!(
            DELAYED_OPERATION_SCHEDULE_KEY,
            "vela:relay:delayed-user-operation-schedule"
        );
    }

    #[test]
    fn malformed_dead_letter_is_lossless_and_position_idempotent() {
        let payload = [0, 1, 0xfe, 0xff];
        let dead_letter =
            malformed_dead_letter(42161, 7, 99, &payload, "invalid JSON", Some("0xuserop"));

        assert_eq!(dead_letter.payload_hex, "0x0001feff");
        assert_eq!(dead_letter.user_operation_hash.as_deref(), Some("0xuserop"));
        assert_eq!(
            malformed_dead_letter_key(42161, 7, 99),
            "vela:relay:malformed-dead-letter:42161:7:99"
        );
    }
}
