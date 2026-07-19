use std::{fmt::Display, str::FromStr};

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::{eip2718::Encodable2718, eip2930::AccessList},
    network::TxSignerSync,
    primitives::{Address, Bytes, TxKind, U256, keccak256},
    signers::{SignerSync, local::PrivateKeySigner},
};

#[derive(Clone, Debug)]
pub(super) struct TransactionPlan {
    pub(super) chain_id: u64,
    pub(super) nonce: u64,
    pub(super) gas_limit: u64,
    pub(super) max_fee_per_gas: u128,
    pub(super) max_priority_fee_per_gas: u128,
    pub(super) to: Address,
    pub(super) value: U256,
    pub(super) input: Bytes,
}

/// Native Tempo transaction envelope (EIP-2718 type `0x76`). Tempo does not have a native
/// gas coin: this envelope charges gas in `fee_token` (normally pathUSD) instead of ETH.
#[derive(Clone, Debug)]
pub(super) struct TempoTransactionPlan {
    pub(super) chain_id: u64,
    pub(super) nonce: u64,
    pub(super) gas_limit: u64,
    pub(super) max_fee_per_gas: u128,
    pub(super) max_priority_fee_per_gas: u128,
    pub(super) fee_token: Address,
    pub(super) to: Address,
    pub(super) input: Bytes,
}

#[derive(Clone, Debug)]
pub(super) struct SignedTransaction {
    pub(super) transaction_hash: String,
    pub(super) raw_transaction: Vec<u8>,
    pub(super) nonce: u64,
}

#[derive(Debug)]
pub(super) struct TransactionSignError;

impl Display for TransactionSignError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("could not sign EIP-1559 transaction")
    }
}

impl std::error::Error for TransactionSignError {}

pub(super) fn sign_eip1559(
    secret_key: &k256::SecretKey,
    plan: TransactionPlan,
) -> Result<SignedTransaction, TransactionSignError> {
    let signer = PrivateKeySigner::from(secret_key.clone());
    let mut transaction = TxEip1559 {
        chain_id: plan.chain_id,
        nonce: plan.nonce,
        gas_limit: plan.gas_limit,
        max_fee_per_gas: plan.max_fee_per_gas,
        max_priority_fee_per_gas: plan.max_priority_fee_per_gas,
        to: TxKind::Call(plan.to),
        value: plan.value,
        access_list: AccessList::default(),
        input: plan.input,
    };
    let signature = signer
        .sign_transaction_sync(&mut transaction)
        .map_err(|_| TransactionSignError)?;
    let envelope: TxEnvelope = transaction.into_signed(signature).into();
    let transaction_hash = envelope.hash().to_string();
    let raw_transaction = envelope.encoded_2718();

    Ok(SignedTransaction {
        transaction_hash,
        raw_transaction,
        nonce: plan.nonce,
    })
}

/// Signs a Tempo `0x76` transaction using the protocol's canonical RLP envelope.  Alloy knows
/// Ethereum's standard envelopes but Tempo's fee-token transaction is intentionally custom, so
/// keep the small, audited encoding here rather than attempting to shoehorn it into EIP-1559.
pub(super) fn sign_tempo(
    secret_key: &k256::SecretKey,
    plan: TempoTransactionPlan,
) -> Result<SignedTransaction, TransactionSignError> {
    let unsigned = encode_tempo_transaction(&plan, None);
    let signer = PrivateKeySigner::from(secret_key.clone());
    let signing_hash = keccak256(&unsigned);
    let signature = signer
        .sign_hash_sync(&signing_hash)
        .map_err(|_| TransactionSignError)?;
    let raw_transaction = encode_tempo_transaction(&plan, Some(&signature));
    let transaction_hash = keccak256(&raw_transaction).to_string();

    Ok(SignedTransaction {
        transaction_hash,
        raw_transaction,
        nonce: plan.nonce,
    })
}

/// Tempo encodes a single ordinary contract call as `calls = [[to, value, data]]`.  All omitted
/// fields are canonical RLP empty strings/lists. Its secp256k1 signature keeps Ethereum's 27/28
/// recovery byte (not the 0/1 y-parity byte used by EIP-1559 typed envelopes).
fn encode_tempo_transaction(
    plan: &TempoTransactionPlan,
    signature: Option<&alloy::primitives::Signature>,
) -> Vec<u8> {
    let call = rlp_list(&[
        rlp_bytes(plan.to.as_slice()),
        rlp_bytes(&[]),
        rlp_bytes(plan.input.as_ref()),
    ]);
    let calls = rlp_list(&[call]);
    let access_list = rlp_list(&[]);
    let authorization_list = rlp_list(&[]);
    let signature = signature.map(|signature| {
        let mut bytes = Vec::with_capacity(65);
        bytes.extend_from_slice(&signature.r().to_be_bytes::<32>());
        bytes.extend_from_slice(&signature.s().to_be_bytes::<32>());
        bytes.push(signature.v_byte());
        rlp_bytes(&bytes)
    });
    let mut fields = vec![
        rlp_u64(plan.chain_id),
        rlp_u128(plan.max_priority_fee_per_gas),
        rlp_u128(plan.max_fee_per_gas),
        rlp_u64(plan.gas_limit),
        calls,
        access_list,
        rlp_bytes(&[]), // nonce key
        rlp_u64(plan.nonce),
        rlp_bytes(&[]), // valid before
        rlp_bytes(&[]), // valid after
        rlp_bytes(plan.fee_token.as_slice()),
        rlp_bytes(&[]), // no fee payer
        authorization_list,
    ];
    if let Some(signature) = signature {
        fields.push(signature);
    }
    let mut encoded = Vec::with_capacity(1 + fields.iter().map(Vec::len).sum::<usize>() + 8);
    encoded.push(0x76);
    encoded.extend(rlp_list(&fields));
    encoded
}

fn rlp_u64(value: u64) -> Vec<u8> {
    rlp_bytes(trimmed_be_bytes(&value.to_be_bytes()))
}

fn rlp_u128(value: u128) -> Vec<u8> {
    rlp_bytes(trimmed_be_bytes(&value.to_be_bytes()))
}

fn trimmed_be_bytes(value: &[u8]) -> &[u8] {
    match value.iter().position(|byte| *byte != 0) {
        Some(index) => &value[index..],
        None => &[],
    }
}

fn rlp_bytes(value: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(value.len() + 9);
    match value.len() {
        0 => encoded.push(0x80),
        1 if value[0] < 0x80 => encoded.push(value[0]),
        length if length < 56 => {
            encoded.push(0x80 + length as u8);
            encoded.extend_from_slice(value);
        }
        length => {
            let length_bytes = (length as u64).to_be_bytes();
            let length = trimmed_be_bytes(&length_bytes);
            encoded.push(0xb7 + length.len() as u8);
            encoded.extend_from_slice(length);
            encoded.extend_from_slice(value);
        }
    }
    encoded
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload_length = items.iter().map(Vec::len).sum::<usize>();
    let mut encoded = Vec::with_capacity(payload_length + 9);
    if payload_length < 56 {
        encoded.push(0xc0 + payload_length as u8);
    } else {
        let length_bytes = (payload_length as u64).to_be_bytes();
        let length = trimmed_be_bytes(&length_bytes);
        encoded.push(0xf7 + length.len() as u8);
        encoded.extend_from_slice(length);
    }
    for item in items {
        encoded.extend_from_slice(item);
    }
    encoded
}

pub(super) fn signer_address(secret_key: &k256::SecretKey) -> Address {
    let signer = PrivateKeySigner::from(secret_key.clone());
    // The local signer always formats a canonical 20-byte address; keep the conversion explicit so
    // no key material ever crosses a formatting/logging boundary.
    Address::from_str(&signer.address().to_string()).expect("local signer address is valid")
}

#[cfg(test)]
mod tests {
    use alloy::primitives::{U256, address, bytes};
    use k256::SecretKey;

    use super::{TempoTransactionPlan, TransactionPlan, sign_eip1559, sign_tempo};

    #[test]
    fn signing_is_deterministic_and_hashes_the_exact_raw_bytes() {
        let key = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let plan = TransactionPlan {
            chain_id: 42161,
            nonce: 3,
            gas_limit: 100_000,
            max_fee_per_gas: 2_000_000_000,
            max_priority_fee_per_gas: 100_000_000,
            to: address!("1111111111111111111111111111111111111111"),
            value: U256::ZERO,
            input: bytes!("010203"),
        };
        let signed = sign_eip1559(&key, plan.clone()).unwrap();
        let repeated = sign_eip1559(&key, plan).unwrap();

        assert_eq!(signed.raw_transaction, repeated.raw_transaction);
        assert_eq!(signed.transaction_hash, repeated.transaction_hash);
        assert_eq!(
            signed.transaction_hash,
            alloy::primitives::keccak256(&signed.raw_transaction).to_string()
        );
    }

    #[test]
    fn signs_the_canonical_tempo_fee_token_envelope() {
        let key = SecretKey::from_slice(&[7u8; 32]).unwrap();
        let signed = sign_tempo(
            &key,
            TempoTransactionPlan {
                chain_id: 4217,
                nonce: 3,
                gas_limit: 123_456,
                max_fee_per_gas: 30_000_000_000,
                max_priority_fee_per_gas: 0,
                fee_token: address!("20c0000000000000000000000000000000000000"),
                to: address!("1111111111111111111111111111111111111111"),
                input: bytes!("01020304"),
            },
        )
        .unwrap();
        assert_eq!(
            format!("0x{}", hex::encode(&signed.raw_transaction)),
            "0x76f88a821079808506fc23ac008301e240dcdb941111111111111111111111111111111111111111808401020304c0800380809420c000000000000000000000000000000000000080c0b841f86dd2eac225b4ad52ef221bd8508381d447eec08681d1906c4eabf747d6c4e30df7c906a1ea9daa1e57587d9f0d9395f5ac7de0f92d5e6b60053084d902351b1c"
        );
        assert_eq!(
            signed.transaction_hash,
            alloy::primitives::keccak256(&signed.raw_transaction).to_string()
        );
    }
}
