use std::{
    collections::HashSet,
    fmt::{Display, Formatter},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use iggy::prelude::{
    Client, CompressionAlgorithm, Identifier, IggyClient, IggyDuration, IggyExpiry, IggyMessage,
    MaxTopicSize, MessageClient, Partitioning, StreamClient, TopicClient,
};
use serde_json::Value;

use crate::utils::config::IggyConfig;

/// Durable admission queue for accepted UserOperations.
///
/// The Iggy server is the source of truth. The process-local pending set is only a best-effort
/// optimization for idempotent retries while this process is alive.
#[derive(Clone)]
pub struct UserOperationQueue {
    client: Arc<IggyClient>,
    topic: Identifier,
    topic_name: String,
    enqueue_timeout: Duration,
    topology_provisioner: Option<ChainTopologyProvisioner>,
}

#[derive(Clone)]
struct ChainTopologyProvisioner {
    client: Arc<IggyClient>,
    allowed_chain_ids: Arc<HashSet<u64>>,
    provision_lock: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Debug)]
pub struct UserOperationQueueError(&'static str);

impl Display for UserOperationQueueError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for UserOperationQueueError {}

impl UserOperationQueue {
    /// Connects the message producer and, when configured, a separately privileged topology
    /// provisioner. The latter can only create streams for allowlisted chain IDs.
    pub async fn connect(config: &IggyConfig) -> Result<Self, UserOperationQueueError> {
        let client = IggyClient::from_connection_string(&config.url)
            .map_err(|_| UserOperationQueueError("invalid Iggy connection configuration"))?;
        client
            .connect()
            .await
            .map_err(|_| UserOperationQueueError("could not connect to Iggy"))?;

        let topology_provisioner = match &config.provisioner_url {
            Some(url) => {
                let client = IggyClient::from_connection_string(url).map_err(|_| {
                    UserOperationQueueError("invalid Iggy provisioner connection configuration")
                })?;
                client.connect().await.map_err(|_| {
                    UserOperationQueueError("could not connect to Iggy topology provisioner")
                })?;
                Some(ChainTopologyProvisioner {
                    client: Arc::new(client),
                    allowed_chain_ids: Arc::new(
                        config.auto_create_chain_ids.iter().copied().collect(),
                    ),
                    provision_lock: Arc::new(tokio::sync::Mutex::new(())),
                })
            }
            None => None,
        };

        let topic: Identifier = config
            .topic
            .as_str()
            .try_into()
            .map_err(|_| UserOperationQueueError("invalid Iggy topic name"))?;
        tracing::info!(
            topic = %config.topic,
            automatic_topology_provisioning = topology_provisioner.is_some(),
            "Iggy UserOperation queue connected"
        );

        Ok(Self {
            client: Arc::new(client),
            topic,
            topic_name: config.topic.clone(),
            enqueue_timeout: config.enqueue_timeout,
            topology_provisioner,
        })
    }

    /// Appends an operation only after Iggy confirms the write.
    ///
    /// Each chain is isolated in its own `chain-{chain_id}` stream and therefore retains FIFO
    /// ordering without sharing a partition with another chain.
    pub async fn enqueue(
        &self,
        chain_id: u64,
        operation: &Value,
    ) -> Result<(), UserOperationQueueError> {
        let payload = serde_json::to_string(operation).map_err(|_| {
            UserOperationQueueError("could not serialize UserOperation queue entry")
        })?;
        let stream = stream_for_chain(chain_id)?;
        let stream_name = stream_name_for_chain(chain_id);

        match self.append(&stream, &payload).await {
            Ok(()) => Ok(()),
            Err(send_error) => {
                let Some(provisioner) = &self.topology_provisioner else {
                    return Err(send_error);
                };
                if !provisioner.allowed_chain_ids.contains(&chain_id) {
                    return Err(send_error);
                }

                let topology_was_created = tokio::time::timeout(
                    self.enqueue_timeout,
                    provisioner.ensure_chain_topic(
                        &stream,
                        &stream_name,
                        &self.topic,
                        &self.topic_name,
                    ),
                )
                .await
                .map_err(|_| UserOperationQueueError("Iggy topology provisioning timed out"))??;
                if !topology_was_created {
                    return Err(send_error);
                }

                self.append(&stream, &payload).await
            }
        }
    }

    async fn append(
        &self,
        stream: &Identifier,
        payload: &str,
    ) -> Result<(), UserOperationQueueError> {
        let message = IggyMessage::from_str(payload)
            .map_err(|_| UserOperationQueueError("UserOperation queue entry is invalid"))?;
        let mut messages = [message];

        match tokio::time::timeout(
            self.enqueue_timeout,
            self.client.send_messages(
                stream,
                &self.topic,
                &Partitioning::balanced(),
                &mut messages,
            ),
        )
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(UserOperationQueueError(
                "Iggy rejected the UserOperation queue entry",
            )),
            Err(_) => Err(UserOperationQueueError(
                "Iggy UserOperation queue write timed out",
            )),
        }
    }
}

impl ChainTopologyProvisioner {
    /// Creates `chain-{id}` and its single-partition topic only after a producer write failed.
    /// A shared lock avoids duplicate create races among concurrent requests in one relay.
    /// Returns false when the stream and topic already exist, so an unrelated producer error is
    /// not hidden by a successful metadata lookup.
    async fn ensure_chain_topic(
        &self,
        stream: &Identifier,
        stream_name: &str,
        topic: &Identifier,
        topic_name: &str,
    ) -> Result<bool, UserOperationQueueError> {
        let _lock = self.provision_lock.lock().await;
        let stream_was_missing = self
            .client
            .get_stream(stream)
            .await
            .map_err(|_| UserOperationQueueError("could not inspect Iggy chain stream"))?
            .is_none();
        if stream_was_missing {
            self.create_stream_if_missing(stream, stream_name).await?;
        }

        let topic_was_missing = self
            .client
            .get_topic(stream, topic)
            .await
            .map_err(|_| UserOperationQueueError("could not inspect Iggy chain topic"))?
            .is_none();
        if topic_was_missing {
            self.create_topic_if_missing(stream, topic, topic_name)
                .await?;
        }

        if stream_was_missing || topic_was_missing {
            tracing::info!(
                stream = stream_name,
                topic = topic_name,
                "created Iggy UserOperation queue topology"
            );
        }
        Ok(stream_was_missing || topic_was_missing)
    }

    async fn create_stream_if_missing(
        &self,
        stream: &Identifier,
        stream_name: &str,
    ) -> Result<(), UserOperationQueueError> {
        if self.client.create_stream(stream_name).await.is_ok() {
            return Ok(());
        }

        if self
            .client
            .get_stream(stream)
            .await
            .map_err(|_| UserOperationQueueError("could not inspect Iggy chain stream"))?
            .is_some()
        {
            return Ok(());
        }

        Err(UserOperationQueueError(
            "could not create Iggy chain stream",
        ))
    }

    async fn create_topic_if_missing(
        &self,
        stream: &Identifier,
        topic: &Identifier,
        topic_name: &str,
    ) -> Result<(), UserOperationQueueError> {
        let expiry =
            IggyExpiry::ExpireDuration(IggyDuration::new(Duration::from_secs(14 * 24 * 60 * 60)));
        if self
            .client
            .create_topic(
                stream,
                topic_name,
                1,
                CompressionAlgorithm::None,
                None,
                expiry,
                MaxTopicSize::ServerDefault,
            )
            .await
            .is_ok()
        {
            return Ok(());
        }

        if self
            .client
            .get_topic(stream, topic)
            .await
            .map_err(|_| UserOperationQueueError("could not inspect Iggy chain topic"))?
            .is_some()
        {
            return Ok(());
        }

        Err(UserOperationQueueError("could not create Iggy chain topic"))
    }
}

fn stream_for_chain(chain_id: u64) -> Result<Identifier, UserOperationQueueError> {
    stream_name_for_chain(chain_id)
        .as_str()
        .try_into()
        .map_err(|_| UserOperationQueueError("invalid Iggy stream name for chain"))
}

fn stream_name_for_chain(chain_id: u64) -> String {
    format!("chain-{chain_id}")
}

#[cfg(test)]
mod tests {
    use std::{env, time::Duration};

    use serde_json::json;

    use super::{UserOperationQueue, stream_for_chain};
    use crate::utils::config::IggyConfig;

    #[test]
    fn derives_a_stream_name_from_the_chain_id() {
        let stream = stream_for_chain(42_161).unwrap();

        assert_eq!(stream.get_string_value().unwrap(), "chain-42161");
    }

    #[tokio::test]
    #[ignore = "requires a running Iggy server and VELA_RELAY_IGGY_URL"]
    async fn appends_to_a_preprovisioned_chain_stream() {
        let queue = UserOperationQueue::connect(&IggyConfig {
            url: env::var("VELA_RELAY_IGGY_URL").expect("Iggy connection URL"),
            provisioner_url: None,
            auto_create_chain_ids: Vec::new(),
            topic: "default".into(),
            enqueue_timeout: Duration::from_secs(5),
        })
        .await
        .expect("connect to Iggy");

        queue
            .enqueue(
                1,
                &json!({
                    "schemaVersion": 1,
                    "userOperationHash": "0xiggy-integration-test",
                    "chainId": 1,
                }),
            )
            .await
            .expect("append test envelope");
    }
}
