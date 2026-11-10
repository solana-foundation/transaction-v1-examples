//! Offline tests: the PDA, the nonce successor, and the two signed messages.
//!
//! The fixtures are shared with `ts/kit/test/wire.test.ts`, so the TypeScript
//! port of the authorization message layout is checked byte for byte against
//! the Anza client crate. Run with `--nocapture` to print fresh values.

use base64::prelude::{Engine, BASE64_STANDARD};
use psigner::signer::{
    authorization_message, execution_message, programmatic_signer_address, sign_authorization,
};
use psigner::spl_nonce::next_nonce;
use psigner::token::{associated_token_address, transfer_to_ata};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::v1;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_nonce_interface::state::Nonce;

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
const EXPECTED_AUTHORIZATION_MESSAGE: &str = "gQEAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEH6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLPaWlfj5JYuK1SNOpr++SvWDuDtHoo2hDLZ0DIYFQcOAWWGT5rG9fLwDcrw+nggq710Pl+QXhA8DKWM9aBvVZsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBp0AAgEFAgMGAIEBAAEAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQBA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICDAAAAQIAAACAlpgAAAAAAA==";
const EXPECTED_NEXT_NONCE: &str = "CWEzUvYuebSfqxWZHrdUg6NcPe5ZzS2PtFAsrKRDWmUn";
const EXPECTED_TOKEN_EXECUTION_MESSAGE: &str = "gQEABQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAIIuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3aA/PR7QF250FyMH2Mx66MuKRQ6hPcnvzA+qLmgC39Zc6ti4cNWPY4zevC9Pc6B8gukAsWYMR7GfDTCMEY38J2ZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKmMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQcGAQAGBAoAAAEEBQMGAQIFAQAMgJaYAAAAAAAG";

fn fixture() -> (Keypair, Address, v1::Message, v1::Message) {
    let authority = Keypair::new_from_array(AUTHORITY_SEED);
    let pda = programmatic_signer_address(&authority.pubkey());
    let transfer = system_instruction::transfer(&pda, &RECIPIENT, AMOUNT);
    let execution = execution_message(&pda, &[transfer], NONCE).unwrap();
    let authorization =
        authorization_message(&execution, &NONCE_ACCOUNT, &pda, &[authority.pubkey()]).unwrap();
    (authority, pda, execution, authorization)
}

#[test]
fn pda_is_derived_from_the_documented_seeds() {
    let (authority, pda, _, _) = fixture();
    let (expected, _) = Address::find_program_address(
        &[b"programmatic-signer", authority.pubkey().as_ref()],
        &spl_ed25519_signer_client::ID,
    );
    assert_eq!(pda, expected);
    assert_eq!(authority.pubkey().to_string(), EXPECTED_AUTHORITY);
    assert_eq!(pda.to_string(), EXPECTED_PDA);
}

#[test]
fn execution_message_is_v1_with_the_nonce_as_lifetime_and_no_config() {
    let (_, pda, execution, _) = fixture();
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
fn authorization_message_wraps_execute_and_is_signed_by_the_authority_only() {
    let (authority, pda, execution, authorization) = fixture();
    let signers =
        &authorization.account_keys[..usize::from(authorization.header.num_required_signatures)];
    assert_eq!(
        signers,
        &[authority.pubkey()],
        "the cold key is the only required signer"
    );
    assert!(
        !signers.contains(&pda),
        "the PDA signs by promotion, not with a signature"
    );
    assert_eq!(
        authorization.lifetime_specifier,
        Hash::default(),
        "no blockhash"
    );
    assert_eq!(
        authorization.config,
        v1::TransactionConfig::default(),
        "no config"
    );
    assert_eq!(
        authorization.instructions.len(),
        1,
        "exactly one instruction"
    );
    let instruction = &authorization.instructions[0];
    assert_eq!(
        authorization.account_keys[usize::from(instruction.program_id_index)],
        spl_message_executor_interface::ID,
        "and it is Execute"
    );
    // The execution message travels inside the instruction data, after the tag.
    assert!(instruction.data.ends_with(&execution.serialize()));
    assert_eq!(
        BASE64_STANDARD.encode(authorization.serialize()),
        EXPECTED_AUTHORIZATION_MESSAGE
    );
}

#[test]
fn signature_covers_the_authorization_message_bytes() {
    let (authority, _, _, authorization) = fixture();
    let signature = sign_authorization(&authorization, &authority);
    assert!(signature.verify(authority.pubkey().as_ref(), &authorization.serialize()));
    let mut tampered = authorization.serialize();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(!signature.verify(authority.pubkey().as_ref(), &tampered));
}

#[test]
fn next_nonce_is_predictable_from_the_execution_message() {
    let (_, _, execution, _) = fixture();
    assert_eq!(
        next_nonce(&NONCE_ACCOUNT, &execution).to_string(),
        EXPECTED_NEXT_NONCE
    );

    // The successor depends on the message: change the amount, change the chain.
    let (_, pda, _, _) = fixture();
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
fn successor_derivation_matches_the_nonce_program_vectors() {
    // Frozen in nonce/interface/src/state.rs of the pinned Anza commit.
    let state = Nonce {
        nonce: "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq"
            .parse()
            .unwrap(),
        ..Nonce::default()
    };
    assert_eq!(
        state
            .derive_next_nonce(
                &Address::from([1; 32]),
                &Address::from([2; 32]),
                &Hash::from([4; 32])
            )
            .to_string(),
        "EgbzChWYoCDgPbJNWv8nVUqdxnoxDTRXg2stzPKhYZu4"
    );
}

#[test]
fn a_token_withdrawal_creates_the_destination_and_transfers_as_the_pda() {
    let (_, pda, _, _) = fixture();
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
        associated_token_address(&pda, &MINT),
        "out of the PDA's associated token account"
    );
    assert_eq!(
        instructions[1].accounts[2].pubkey,
        associated_token_address(&RECIPIENT, &MINT),
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
