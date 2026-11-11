//! Tests that run against a live validator.
//!
//! These are `#[ignore]`d so `cargo test` stays offline by default. Run them
//! with `just test-live`, which starts a validator with the three programs
//! loaded first. The endpoint comes from `PSIGNER_RPC_URL`.

use anyhow::Result;
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::token::{create_mint, fetch_balance, mint_to_ata, transfer_to_ata};
use psigner::DEFAULT_RPC_URL;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_ed25519_signer_client::instruction::submit;
use spl_ed25519_signer_client::message::authorization_message;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;

fn rpc_url() -> String {
    std::env::var("PSIGNER_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string())
}

/// A funded relayer, a cold authority, its PDA holding 0.1 SOL, and a nonce
/// account the PDA controls.
struct Setup {
    client: RpcClient,
    relayer: Keypair,
    authority: Keypair,
    pda: Address,
    nonce_account: Address,
}

fn setup() -> Result<Setup> {
    let client = client(&rpc_url());
    assert_programs_deployed(&client)?;
    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let authority = Keypair::new();
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    send_transaction(
        &client,
        &relayer,
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &pda,
            100_000_000,
        )],
        &[&relayer],
    )?;
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    Ok(Setup {
        client,
        relayer,
        authority,
        pda,
        nonce_account,
    })
}

impl Setup {
    fn nonce(&self) -> Result<solana_hash::Hash> {
        Ok(fetch_nonce(&self.client, &self.nonce_account)?.nonce)
    }

    /// The cold side: wraps `execution` in an Execute instruction and signs it.
    fn sign(&self, execution: &v1::Message) -> Result<Instruction> {
        let execute = execute(&self.nonce_account, &self.pda, execution);
        Ok(sign_and_submit(&execute, &[&self.authority])?)
    }

    /// The hot side: sends a Submit instruction from the relayer.
    fn relay(&self, submit: &Instruction) -> Result<(), String> {
        send_transaction(
            &self.client,
            &self.relayer,
            std::slice::from_ref(submit),
            &[&self.relayer],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    }
}

/// Both the Executor's `NonceMismatch` and the Signer's `InvalidSignature`
/// surface as custom error 3; the caller says which one it expects.
fn assert_custom_error_3(result: Result<(), String>, expected: &str) {
    let Err(error) = result else {
        panic!("expected {expected}, but the relay landed");
    };
    assert!(
        error.contains("custom program error: 0x3"),
        "expected {expected}, got: {error}"
    );
}

#[test]
#[ignore = "requires a running validator"]
fn a_cold_signed_transfer_relays_once_and_advances_the_nonce_as_predicted() -> Result<()> {
    let s = setup()?;
    let recipient = Keypair::new().pubkey();
    let nonce = fetch_nonce(&s.client, &s.nonce_account)?;
    assert_eq!(nonce.authority, s.pda);

    let execution = execution_message(
        &s.pda,
        &[system_instruction::transfer(&s.pda, &recipient, 1_000_000)],
        nonce.nonce,
    )?;
    let submit = s.sign(&execution)?;
    let predicted = next_nonce(&s.nonce_account, &execution);

    s.relay(&submit).unwrap();
    assert_eq!(s.client.get_balance(&recipient)?, 1_000_000);
    assert_eq!(s.nonce()?, predicted);

    assert_custom_error_3(s.relay(&submit), "NonceMismatch");
    assert_eq!(s.client.get_balance(&recipient)?, 1_000_000);
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn a_tampered_authorization_is_rejected() -> Result<()> {
    let s = setup()?;
    let recipient = Keypair::new().pubkey();
    let nonce = s.nonce()?;

    // Sign one amount, relay another: the signature over the first
    // authorization message travels with the second.
    let authorization = |lamports| -> Result<v1::Message> {
        let execution = execution_message(
            &s.pda,
            &[system_instruction::transfer(&s.pda, &recipient, lamports)],
            nonce,
        )?;
        let execute = execute(&s.nonce_account, &s.pda, &execution);
        Ok(authorization_message(&execute, &[s.authority.pubkey()])?)
    };
    let signature = s
        .authority
        .sign_message(&authorization(1_000_000)?.serialize());
    let tampered = submit(
        vec![Some(signature)],
        VersionedMessage::V1(authorization(2_000_000)?),
    );
    assert_custom_error_3(s.relay(&tampered), "InvalidSignature");
    assert_eq!(s.client.get_balance(&recipient)?, 0);
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn a_cold_signed_token_withdrawal_creates_the_destination_and_lands() -> Result<()> {
    let s = setup()?;
    let recipient = Keypair::new().pubkey();
    let mint = create_mint(&s.client, &s.relayer)?;
    let pda_account = mint_to_ata(&s.client, &s.relayer, &mint, &s.pda, 1_000_000_000)?;
    let nonce = s.nonce()?;

    let execution = execution_message(
        &s.pda,
        &transfer_to_ata(&mint, &s.pda, &recipient, 250_000_000)?,
        nonce,
    )?;
    let submit = s.sign(&execution)?;
    let predicted = next_nonce(&s.nonce_account, &execution);

    s.relay(&submit).unwrap();
    let recipient_account = get_associated_token_address(&recipient, &mint);
    assert_eq!(fetch_balance(&s.client, &recipient_account)?, 250_000_000);
    assert_eq!(fetch_balance(&s.client, &pda_account)?, 750_000_000);
    assert_eq!(s.nonce()?, predicted);
    assert_custom_error_3(s.relay(&submit), "NonceMismatch");
    Ok(())
}
