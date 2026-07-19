use std::{fmt::Display, str::FromStr};

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::{eip2718::Encodable2718, eip2930::AccessList},
    network::TxSignerSync,
    primitives::{Address, Bytes, TxKind, U256},
    signers::local::PrivateKeySigner,
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

    use super::{TransactionPlan, sign_eip1559};

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
}
