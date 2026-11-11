//! Offline tests: the execution message, the authorization message, and the
//! next nonce, for one fixed set of inputs.
//!
//! The expected values are shared with `ts/kit/test/wire.test.ts`, so the
//! TypeScript helpers that stand in for missing client functions are checked
//! against what the Anza client crates produce.

use base64::prelude::{Engine, BASE64_STANDARD};
use psigner::signer::execution_message;
use psigner::spl_nonce::next_nonce;
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::v1;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_ed25519_signer_client::message::authorization_message;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;

/// Fixed inputs. The authority's secret key is 32 bytes of 7, which kit's
/// `createKeyPairFromPrivateKeyBytes` turns into the same public key.
const AUTHORITY_SEED: [u8; 32] = [7; 32];
const RECIPIENT: Address = Address::new_from_array([2; 32]);
const NONCE_ACCOUNT: Address = Address::new_from_array([3; 32]);
const NONCE: Hash = Hash::new_from_array([4; 32]);
const AMOUNT: u64 = 10_000_000;

/// Expected outputs for the inputs above.
const EXPECTED_EXECUTION_MESSAGE: &str = "gQEAAQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAEDuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3YCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIMAAABAgAAAICWmAAAAAAA";
const EXPECTED_AUTHORIZATION_MESSAGE: &str = "gQEABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEI6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLPaWlfj5JYuK1SNOpr++SvWDuDtHoo2hDLZ0DIYFQcOAWWGT5rG9fLwDcrw+nggq710Pl+QXhA8DKWM9aBvVZsy/dBGfmAqhXLmy1s8ZgUf7C7Mf6E2VM3yGC6u0UgpYcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQHnQACAQUGAgMHAIEBAAEAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQBA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICDAAAAQIAAACAlpgAAAAAAA==";
const EXPECTED_NEXT_NONCE: &str = "SewSJdKpN41PPGEVRoSTvX6kEW2JSGoZbd9iPxtzf94";

fn fixture() -> (Keypair, Address, v1::Message) {
    let authority = Keypair::new_from_array(AUTHORITY_SEED);
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    let transfer = system_instruction::transfer(&pda, &RECIPIENT, AMOUNT);
    let execution = execution_message(&pda, &[transfer], NONCE).unwrap();
    (authority, pda, execution)
}

#[test]
fn execution_message_matches_the_shared_fixture() {
    let (_, _, execution) = fixture();
    assert_eq!(
        BASE64_STANDARD.encode(execution.serialize()),
        EXPECTED_EXECUTION_MESSAGE
    );
}

#[test]
fn authorization_message_from_the_client_crate() {
    let (authority, pda, execution) = fixture();
    let execute = execute(&NONCE_ACCOUNT, &pda, &execution);
    let authorization = authorization_message(&execute, &[authority.pubkey()]).unwrap();
    assert_eq!(
        BASE64_STANDARD.encode(authorization.serialize()),
        EXPECTED_AUTHORIZATION_MESSAGE
    );
}

#[test]
fn next_nonce_is_known_from_the_execution_message() {
    let (_, _, execution) = fixture();
    assert_eq!(
        next_nonce(&NONCE_ACCOUNT, &execution).to_string(),
        EXPECTED_NEXT_NONCE
    );
}
