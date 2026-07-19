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

#[derive(Debug, Eq, PartialEq)]
pub enum VaultError {
    EmptySecret,
    InvalidHex,
    InvalidLength,
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
            Self::NoValidPrivateKey => {
                formatter.write_str("could not derive a valid secp256k1 private key")
            }
        }
    }
}

impl Error for VaultError {}

pub fn derive_address(operator_secret: &str) -> Result<String, VaultError> {
    let ikm = parse_operator_secret(operator_secret)?;
    let private_key = derive_private_key(&ikm)?;
    ethereum_address(private_key)
}

fn ethereum_address(private_key: SecretKey) -> Result<String, VaultError> {
    let public_key = private_key.public_key().to_encoded_point(false);
    let digest = Keccak256::digest(&public_key.as_bytes()[1..]);

    Ok(format!("0x{}", hex::encode(&digest[12..])))
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

fn derive_private_key(ikm: &[u8]) -> Result<SecretKey, VaultError> {
    let hkdf = Hkdf::<Sha256>::new(Some(DERIVATION_SALT), ikm);

    for counter in 0..256 {
        let info = match counter {
            0 => TREASURY_INFO.to_owned(),
            _ => format!("{TREASURY_INFO}|counter={counter}"),
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
    use super::{VaultError, derive_address};

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
}
