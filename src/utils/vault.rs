use std::{
    error::Error,
    fmt::{Display, Formatter},
};

use hkdf::Hkdf;
use k256::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use sha2::Sha256;
use sha3::{Digest, Keccak256};

const DERIVATION_SALT: &[u8] = b"vela-bundler-dedicated-eoa-v1";
const TREASURY_INFO: &str = "treasury";

/// The immutable key-derivation ceiling shared with `vela-bundler`.
///
/// Reducing this value can strand funds or in-flight transactions belonging to
/// a previously-derived relayer, so deployments should instead change their
/// active routing width.
pub const RELAYER_POOL_SIZE: usize = 100;

/// The number of relayer EOAs used for new traffic unless configured otherwise.
pub const RELAYER_ROUTING_WIDTH: usize = 10;

#[derive(Debug, Eq, PartialEq)]
pub enum VaultError {
    EmptySecret,
    InvalidHex,
    InvalidLength,
    InvalidPoolIndex(usize),
    NoValidPrivateKey,
}

impl Display for VaultError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptySecret => formatter.write_str("OPERATOR_SECRET is required"),
            Self::InvalidHex => formatter.write_str("OPERATOR_SECRET must be hexadecimal"),
            Self::InvalidLength => formatter.write_str(
                "OPERATOR_SECRET must contain an even number of hexadecimal characters and be at least 32 bytes",
            ),
            Self::InvalidPoolIndex(index) => write!(
                formatter,
                "pool relayer index must be in [0, {}], got {index}",
                RELAYER_POOL_SIZE - 1
            ),
            Self::NoValidPrivateKey => {
                formatter.write_str("could not derive a valid secp256k1 private key")
            }
        }
    }
}

impl Error for VaultError {}

pub fn derive_address(operator_secret: &str) -> Result<String, VaultError> {
    let private_key = derive_treasury_secret_key(operator_secret)?;
    Ok(ethereum_address(&private_key))
}

/// Derive the treasury signer used only by the worker's serialized gas top-up path.
pub(crate) fn derive_treasury_secret_key(operator_secret: &str) -> Result<SecretKey, VaultError> {
    let ikm = parse_operator_secret(operator_secret)?;
    derive_private_key(&ikm, TREASURY_INFO)
}

/// Derive the address of relayer `index` from `OPERATOR_SECRET`.
///
/// The derivation deliberately contains no chain ID, so an index resolves to
/// the same address on every EVM chain.
pub fn derive_pool_relayer_address(
    operator_secret: &str,
    index: usize,
) -> Result<String, VaultError> {
    let private_key = derive_pool_relayer_secret_key(operator_secret, index)?;
    Ok(ethereum_address(&private_key))
}

/// Derive the local signing key of relayer `index`.
///
/// This stays crate-visible so private-key material cannot become part of the
/// relay's public API. `k256::SecretKey` redacts `Debug` output and zeroizes its
/// bytes on drop.
pub(crate) fn derive_pool_relayer_secret_key(
    operator_secret: &str,
    index: usize,
) -> Result<SecretKey, VaultError> {
    if index >= RELAYER_POOL_SIZE {
        return Err(VaultError::InvalidPoolIndex(index));
    }

    let ikm = parse_operator_secret(operator_secret)?;
    derive_private_key(&ikm, &format!("relayer-#{index}"))
}

/// Route a sender to a relayer using its low 32 bits, exactly as
/// `vela-bundler/shared/queue/routing.ts` does for valid EVM addresses.
///
/// A zero width falls back to [`RELAYER_ROUTING_WIDTH`]. Malformed senders are
/// routed to index zero; normal request validation must still reject them.
pub fn relayer_index_for_sender(sender: &str, width: usize) -> usize {
    let width = if width == 0 {
        RELAYER_ROUTING_WIDTH
    } else {
        width
    };
    let clean = sender
        .strip_prefix("0x")
        .or_else(|| sender.strip_prefix("0X"))
        .unwrap_or(sender);
    let last_eight = clean
        .char_indices()
        .rev()
        .nth(7)
        .map_or(clean, |(index, _)| &clean[index..]);

    u32::from_str_radix(last_eight, 16).map_or(0, |value| value as usize % width)
}

fn ethereum_address(private_key: &SecretKey) -> String {
    let public_key = private_key.public_key().to_encoded_point(false);
    let digest = Keccak256::digest(&public_key.as_bytes()[1..]);

    format!("0x{}", hex::encode(&digest[12..]))
}

fn parse_operator_secret(value: &str) -> Result<Vec<u8>, VaultError> {
    if value.is_empty() {
        return Err(VaultError::EmptySecret);
    }

    let value = value.strip_prefix("0x").unwrap_or(value);
    if !value.len().is_multiple_of(2) {
        return Err(VaultError::InvalidLength);
    }

    let decoded = hex::decode(value).map_err(|_| VaultError::InvalidHex)?;
    if decoded.len() < 32 {
        return Err(VaultError::InvalidLength);
    }

    Ok(decoded)
}

fn derive_private_key(ikm: &[u8], base_info: &str) -> Result<SecretKey, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(DERIVATION_SALT), ikm);

    for counter in 0..256 {
        let info = match counter {
            0 => base_info.to_owned(),
            _ => format!("{base_info}|counter={counter}"),
        };
        let mut private_key = [0_u8; 32];
        hkdf.expand(info.as_bytes(), &mut private_key)
            .expect("32-byte HKDF output is within SHA-256 limits");

        if let Ok(private_key) = SecretKey::from_slice(&private_key) {
            return Ok(private_key);
        }
    }

    Err(VaultError::NoValidPrivateKey)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{
        RELAYER_POOL_SIZE, RELAYER_ROUTING_WIDTH, VaultError, derive_address,
        derive_pool_relayer_address, derive_pool_relayer_secret_key, relayer_index_for_sender,
    };

    const TEST_SECRET: &str = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    #[test]
    fn matches_the_vela_bundler_treasury_golden_vector() {
        assert_eq!(
            derive_address(TEST_SECRET).unwrap(),
            "0xa823eef708afc3e8e966e2a6b9ff20bb26c1ae54"
        );
    }

    #[test]
    fn accepts_a_secret_without_the_hex_prefix() {
        assert_eq!(
            derive_address(&TEST_SECRET[2..]).unwrap(),
            derive_address(TEST_SECRET).unwrap()
        );
    }

    #[test]
    fn rejects_invalid_operator_secrets() {
        assert_eq!(derive_address(""), Err(VaultError::EmptySecret));
        assert_eq!(derive_address("0xnot-hex"), Err(VaultError::InvalidLength));
        assert_eq!(
            derive_address("0xgggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"),
            Err(VaultError::InvalidHex)
        );
    }

    #[test]
    fn matches_vela_bundler_pool_relayer_golden_vectors() {
        let expected = [
            (0, "0x6d05a1d693ad0fc5189560d5456acde3afe31342"),
            (1, "0x783346e3c11d430c523b41462f81aae91e57fd84"),
            (2, "0xa97ac271de683cb40069aa1f457b7876d3f96995"),
            (50, "0x23c64c8351d3307757bb664af9ca6fde89c40494"),
            (99, "0xea1daafbdae5dea227cf045d99cd7e7f96f51865"),
        ];

        for (index, expected_address) in expected {
            assert_eq!(
                derive_pool_relayer_address(TEST_SECRET, index).unwrap(),
                expected_address,
                "pool relayer #{index}"
            );
        }

        assert_eq!(
            hex::encode(
                derive_pool_relayer_secret_key(TEST_SECRET, 0)
                    .unwrap()
                    .to_bytes()
            ),
            "eca260badba16aa99814aafa0d11978ec3772bd088b294c9032ce278a5b8e2d3"
        );
    }

    #[test]
    fn enforces_the_immutable_pool_ceiling() {
        assert_eq!(RELAYER_POOL_SIZE, 100);
        assert_eq!(RELAYER_ROUTING_WIDTH, 10);
        assert_eq!(
            derive_pool_relayer_address(TEST_SECRET, RELAYER_POOL_SIZE),
            Err(VaultError::InvalidPoolIndex(RELAYER_POOL_SIZE))
        );

        let addresses = (0..RELAYER_POOL_SIZE)
            .map(|index| derive_pool_relayer_address(TEST_SECRET, index).unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(addresses.len(), RELAYER_POOL_SIZE);
    }

    #[test]
    fn secret_key_debug_output_is_redacted() {
        let private_key = derive_pool_relayer_secret_key(TEST_SECRET, 0).unwrap();
        let debug = format!("{private_key:?}");

        assert!(!debug.contains("eca260badba16aa9"));
    }

    #[test]
    fn sender_routing_matches_vela_bundler_vectors() {
        let zeros = format!("0x{}", "00".repeat(20));
        let aa = format!("0x{}", "aa".repeat(20));
        let bb = format!("0x{}", "bb".repeat(20));

        assert_eq!(relayer_index_for_sender(&zeros, 10), 0);
        assert_eq!(
            relayer_index_for_sender(&aa, RELAYER_ROUTING_WIDTH),
            0xaaaa_aaaa_u32 as usize % RELAYER_ROUTING_WIDTH
        );
        assert_eq!(
            relayer_index_for_sender(&bb, RELAYER_ROUTING_WIDTH),
            0xbbbb_bbbb_u32 as usize % RELAYER_ROUTING_WIDTH
        );
        assert_eq!(relayer_index_for_sender(&aa, 100), 30);
        assert_eq!(relayer_index_for_sender(&bb, 100), 83);
        assert_eq!(
            relayer_index_for_sender(&format!("0x{}0064", "00".repeat(18)), RELAYER_ROUTING_WIDTH),
            0
        );
        assert_eq!(
            relayer_index_for_sender(
                &format!("0x{}00000065", "ff".repeat(16)),
                RELAYER_ROUTING_WIDTH
            ),
            1
        );
        assert_eq!(relayer_index_for_sender(&aa, 0), 0);
        assert_eq!(relayer_index_for_sender("not-an-address", 10), 0);
        assert_eq!(
            relayer_index_for_sender(&aa.to_uppercase(), 10),
            relayer_index_for_sender(&aa, 10)
        );
    }
}
