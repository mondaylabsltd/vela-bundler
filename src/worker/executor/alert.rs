use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::{app::UserOperationStatusStore, utils::config::TelegramAlertsConfig};

const TELEGRAM_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ALERT_REASON_BYTES: usize = 700;

static ALERT_TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub(super) struct TelegramAlertNotifier {
    client: Client,
    store: UserOperationStatusStore,
    endpoint: String,
    chat_id: String,
    cooldown: Duration,
}

#[derive(Serialize)]
struct TelegramSendMessage<'a> {
    chat_id: &'a str,
    text: &'a str,
    disable_web_page_preview: bool,
}

#[derive(Deserialize)]
struct TelegramResponse {
    ok: bool,
}

impl TelegramAlertNotifier {
    pub(super) fn new(
        config: &TelegramAlertsConfig,
        store: UserOperationStatusStore,
    ) -> Result<Option<Self>, reqwest::Error> {
        let (Some(bot_token), Some(chat_id)) = (&config.bot_token, &config.chat_id) else {
            return Ok(None);
        };
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(TELEGRAM_TIMEOUT)
            .build()?;
        Ok(Some(Self {
            client,
            store,
            endpoint: format!(
                "https://api.telegram.org/bot{}/sendMessage",
                bot_token.expose()
            ),
            chat_id: chat_id.clone(),
            cooldown: config.cooldown,
        }))
    }

    pub(super) async fn notify_executor_issue(
        &self,
        chain_id: u64,
        stage: &str,
        user_operation_hash: &str,
        reason: &str,
    ) {
        let fingerprint = alert_fingerprint(chain_id, stage, reason);
        let claim_token = unique_alert_token();
        let claimed = match self
            .store
            .claim_executor_alert(&fingerprint, &claim_token, self.cooldown)
            .await
        {
            Ok(claimed) => claimed,
            Err(error) => {
                tracing::warn!(
                    chain_id,
                    stage,
                    %error,
                    "could not acquire Redis Telegram alert suppression slot"
                );
                return;
            }
        };
        if !claimed {
            return;
        }

        let reason = safe_alert_reason(reason);
        let text = format!(
            "Vela Relay executor issue\nchain: {chain_id}\nstage: {stage}\nuser operation: {user_operation_hash}\nreason: {reason}\n\nIdentical chain/stage/reason alerts are suppressed for {} seconds.",
            self.cooldown.as_secs(),
        );
        let delivered = match self
            .client
            .post(&self.endpoint)
            .json(&TelegramSendMessage {
                chat_id: &self.chat_id,
                text: &text,
                disable_web_page_preview: true,
            })
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<TelegramResponse>().await {
                    Ok(response) if response.ok => true,
                    _ => false,
                }
            }
            _ => false,
        };

        if delivered {
            tracing::info!(chain_id, stage, "sent Telegram executor alert");
            return;
        }

        tracing::warn!(
            chain_id,
            stage,
            "could not deliver Telegram executor alert; releasing suppression slot for retry"
        );
        if let Err(error) = self
            .store
            .release_executor_alert(&fingerprint, &claim_token)
            .await
        {
            tracing::warn!(
                chain_id,
                stage,
                %error,
                "could not release Redis Telegram alert suppression slot"
            );
        }
    }
}

fn alert_fingerprint(chain_id: u64, stage: &str, reason: &str) -> String {
    let digest = Keccak256::digest(normalize_reason(reason).as_bytes());
    format!("{chain_id}:{stage}:{}", hex::encode(&digest[..16]))
}

fn normalize_reason(reason: &str) -> String {
    let reason = replace_hex_literals(reason);
    let mut normalized = String::with_capacity(reason.len());
    let mut in_number = false;
    for character in reason.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_digit() {
            if !in_number {
                normalized.push('#');
                in_number = true;
            }
        } else {
            in_number = false;
            if character.is_whitespace() {
                if !normalized.ends_with(' ') {
                    normalized.push(' ');
                }
            } else {
                normalized.push(character);
            }
        }
    }
    normalized.trim().to_owned()
}

fn replace_hex_literals(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut copied_until = 0;
    let mut index = 0;
    while index + 2 <= bytes.len() {
        if bytes[index] != b'0' || !matches!(bytes[index + 1], b'x' | b'X') {
            index += 1;
            continue;
        }

        let start = index;
        index += 2;
        while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
            index += 1;
        }
        // Hashes and addresses make otherwise identical retry errors look unique. Leave short
        // values such as `0x0` intact because they can describe a distinct error condition.
        if index.saturating_sub(start) >= 10 {
            output.push_str(&value[copied_until..start]);
            output.push_str(" <hex> ");
            copied_until = index;
        }
    }
    output.push_str(&value[copied_until..]);
    output
}

fn safe_alert_reason(reason: &str) -> String {
    let filtered = reason
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if filtered.len() <= MAX_ALERT_REASON_BYTES {
        return filtered;
    }

    let end = filtered
        .char_indices()
        .take_while(|(index, character)| {
            index.saturating_add(character.len_utf8()) <= MAX_ALERT_REASON_BYTES.saturating_sub(3)
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    format!("{}...", &filtered[..end])
}

fn unique_alert_token() -> String {
    let sequence = ALERT_TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("telegram:{milliseconds}:{sequence}")
}

#[cfg(test)]
mod tests {
    use super::{alert_fingerprint, normalize_reason, safe_alert_reason};

    #[test]
    fn fingerprint_ignores_changing_numeric_values() {
        assert_eq!(
            alert_fingerprint(137, "funding", "balance is 10, required is 20"),
            alert_fingerprint(137, "funding", "balance is 11, required is 21"),
        );
    }

    #[test]
    fn fingerprint_ignores_changing_hashes() {
        assert_eq!(
            alert_fingerprint(
                137,
                "broadcast",
                "transaction 0x1234567890abcdef is pending"
            ),
            alert_fingerprint(
                137,
                "broadcast",
                "transaction 0xfedcba0987654321 is pending"
            ),
        );
    }

    #[test]
    fn fingerprint_keeps_different_failure_classes_separate() {
        assert_ne!(
            alert_fingerprint(137, "funding", "treasury balance too low"),
            alert_fingerprint(137, "simulation", "treasury balance too low"),
        );
    }

    #[test]
    fn reason_is_single_line_and_bounded() {
        let reason = format!("one\ntwo{}", "x".repeat(800));
        let safe = safe_alert_reason(&reason);
        assert!(!safe.contains('\n'));
        assert!(safe.len() <= 700);
        assert_eq!(normalize_reason("Balance 100 is low"), "balance # is low");
    }
}
