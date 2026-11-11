//! Offline tests: the execution message, the nonce successor, and the token
//! withdrawal.
//!
//! The expected values are shared with `ts/kit/test/wire.test.ts`, so the
//! TypeScript helpers that stand in for missing client functions are checked
//! against what the Anza client crates produce.

use base64::prelude::{Engine, BASE64_STANDARD};
use psigner::signer::execution_message;
use psigner::spl_nonce::next_nonce;
use psigner::token::transfer_to_ata;
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::v1;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account_interface::address::get_associated_token_address;
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
const MINT: Address = Address::new_from_array([5; 32]);

/// Expected outputs for the inputs above.
const EXPECTED_AUTHORITY: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const EXPECTED_PDA: &str = "DPtajHyTTrmEHk3MnyfWVCypdEdyjk1ESbK7UxbaxXqw";
const EXPECTED_EXECUTION_MESSAGE: &str = "gQEAAQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAEDuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3YCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIMAAABAgAAAICWmAAAAAAA";
const EXPECTED_AUTHORIZATION_MESSAGE: &str = "gQEABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEI6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLPaWlfj5JYuK1SNOpr++SvWDuDtHoo2hDLZ0DIYFQcOAWWGT5rG9fLwDcrw+nggq710Pl+QXhA8DKWM9aBvVZsy/dBGfmAqhXLmy1s8ZgUf7C7Mf6E2VM3yGC6u0UgpYcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQHnQACAQUGAgMHAIEBAAEAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQBA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICDAAAAQIAAACAlpgAAAAAAA==";
const EXPECTED_NEXT_NONCE: &str = "SewSJdKpN41PPGEVRoSTvX6kEW2JSGoZbd9iPxtzf94";
const EXPECTED_TOKEN_EXECUTION_MESSAGE: &str = "gQEABQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAIIuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3aA/PR7QF250FyMH2Mx66MuKRQ6hPcnvzA+qLmgC39Zc6ti4cNWPY4zevC9Pc6B8gukAsWYMR7GfDTCMEY38J2ZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKmMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQcGAQAGBAoAAAEEBQMGAQIFAQAMgJaYAAAAAAAG";

fn fixture() -> (Keypair, Address, v1::Message) {
    let authority = Keypair::new_from_array(AUTHORITY_SEED);
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    let transfer = system_instruction::transfer(&pda, &RECIPIENT, AMOUNT);
    let execution = execution_message(&pda, &[transfer], NONCE).unwrap();
    (authority, pda, execution)
}

/// The values the Anza client crates produce for the fixed inputs, which the
/// TypeScript tests compare their own against.
#[test]
fn the_shared_expected_values_are_what_the_client_crates_produce() {
    let (authority, pda, execution) = fixture();
    assert_eq!(authority.pubkey().to_string(), EXPECTED_AUTHORITY);
    assert_eq!(pda.to_string(), EXPECTED_PDA);
    let execute = execute(&NONCE_ACCOUNT, &pda, &execution);
    let authorization = authorization_message(&execute, &[authority.pubkey()]).unwrap();
    assert_eq!(
        BASE64_STANDARD.encode(authorization.serialize()),
        EXPECTED_AUTHORIZATION_MESSAGE
    );
}

#[test]
fn execution_message_is_v1_with_the_nonce_as_lifetime_and_no_config() {
    let (_, pda, execution) = fixture();
    assert_eq!(execution.lifetime_specifier, NONCE);
    assert_eq!(execution.config, v1::TransactionConfig::empty());
    assert_eq!(execution.account_keys[0], pda, "the PDA is the fee payer");
    assert_eq!(
        execution.header.num_required_signatures, 1,
        "and the only signer"
    );
    assert_eq!(execution.instructions.len(), 1);
    assert_eq!(
        BASE64_STANDARD.encode(execution.serialize()),
        EXPECTED_EXECUTION_MESSAGE
    );
}

#[test]
fn next_nonce_is_predictable_from_the_execution_message() {
    let (_, pda, execution) = fixture();
    assert_eq!(
        next_nonce(&NONCE_ACCOUNT, &execution).to_string(),
        EXPECTED_NEXT_NONCE
    );

    // The successor depends on the message: change the amount, change the chain.
    let other = execution_message(
        &pda,
        &[system_instruction::transfer(&pda, &RECIPIENT, AMOUNT + 1)],
        NONCE,
    )
    .unwrap();
    assert_ne!(
        next_nonce(&NONCE_ACCOUNT, &other),
        next_nonce(&NONCE_ACCOUNT, &execution)
    );
}

#[test]
fn a_token_withdrawal_creates_the_destination_and_transfers_as_the_pda() {
    let (_, pda, _) = fixture();
    let instructions = transfer_to_ata(&MINT, &pda, &RECIPIENT, AMOUNT).unwrap();
    assert_eq!(instructions.len(), 2);
    assert_eq!(
        instructions[0].program_id,
        spl_associated_token_account_interface::program::ID
    );
    assert_eq!(
        instructions[0].accounts[0].pubkey, pda,
        "the PDA pays the rent"
    );
    assert!(instructions[0].accounts[0].is_signer);
    assert_eq!(instructions[1].program_id, spl_token_interface::ID);
    assert_eq!(
        instructions[1].accounts[0].pubkey,
        get_associated_token_address(&pda, &MINT),
        "out of the PDA's associated token account"
    );
    assert_eq!(
        instructions[1].accounts[2].pubkey,
        get_associated_token_address(&RECIPIENT, &MINT),
        "into the recipient's"
    );
    assert_eq!(
        instructions[1].accounts[3].pubkey, pda,
        "with the PDA as owner"
    );
    assert!(instructions[1].accounts[3].is_signer);

    let execution = execution_message(&pda, &instructions, NONCE).unwrap();
    assert_eq!(
        execution.header.num_required_signatures, 1,
        "the PDA is the only signer"
    );
    assert_eq!(execution.account_keys[0], pda);
    let encoded = BASE64_STANDARD.encode(execution.serialize());
    println!("EXPECTED_TOKEN_EXECUTION_MESSAGE = {encoded}");
    assert_eq!(encoded, EXPECTED_TOKEN_EXECUTION_MESSAGE);
}
