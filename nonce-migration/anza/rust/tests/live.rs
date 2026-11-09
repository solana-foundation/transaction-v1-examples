//! Tests that run against a live validator.
//!
//! These are `#[ignore]`d so `cargo test` stays offline by default. Run them
//! with `just test-live`, which starts a validator with the three programs
//! loaded first. The endpoint comes from `PSIGNER_RPC_URL`.

use anyhow::Result;
use psigner::cluster::{assert_programs_deployed, client, funded_keypair};
use psigner::nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::signer::{
    authorization_message, execution_message, programmatic_signer, relay_transaction,
    sign_authorization,
};
use psigner::token::{associated_token_address, create_mint, fetch_balance, mint_to, withdraw};
use psigner::DEFAULT_RPC_URL;
use solana_address::Address;
use solana_keypair::Keypair;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;

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
    let pda = programmatic_signer(&authority.pubkey());
    let fund = Transaction::new_signed_with_payer(
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &pda,
            100_000_000,
        )],
        Some(&relayer.pubkey()),
        &[&relayer],
        client.get_latest_blockhash()?,
    );
    client.send_and_confirm_transaction(&fund)?;
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

    fn relay(
        &self,
        authorization: &solana_message::v1::Message,
        signature: solana_signature::Signature,
    ) -> Result<(), String> {
        let relay = relay_transaction(
            authorization,
            vec![signature],
            &self.relayer,
            self.client
                .get_latest_blockhash()
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        self.client
            .send_and_confirm_transaction(&relay)
            .map(|_| ())
            .map_err(|e| e.to_string())
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
    let authorization = authorization_message(
        &execution,
        &s.nonce_account,
        &s.pda,
        &[s.authority.pubkey()],
    )?;
    let signature = sign_authorization(&authorization, &s.authority);
    let predicted = next_nonce(&s.nonce_account, &execution);

    s.relay(&authorization, signature).unwrap();
    assert_eq!(s.client.get_balance(&recipient)?, 1_000_000);
    assert_eq!(s.nonce()?, predicted);

    assert_custom_error_3(s.relay(&authorization, signature), "NonceMismatch");
    assert_eq!(s.client.get_balance(&recipient)?, 1_000_000);
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn a_tampered_authorization_is_rejected() -> Result<()> {
    let s = setup()?;
    let recipient = Keypair::new().pubkey();
    let nonce = s.nonce()?;

    // Sign one amount, relay another.
    let signed = execution_message(
        &s.pda,
        &[system_instruction::transfer(&s.pda, &recipient, 1_000_000)],
        nonce,
    )?;
    let signature = sign_authorization(
        &authorization_message(&signed, &s.nonce_account, &s.pda, &[s.authority.pubkey()])?,
        &s.authority,
    );
    let edited = execution_message(
        &s.pda,
        &[system_instruction::transfer(&s.pda, &recipient, 2_000_000)],
        nonce,
    )?;
    let authorization =
        authorization_message(&edited, &s.nonce_account, &s.pda, &[s.authority.pubkey()])?;
    assert_custom_error_3(s.relay(&authorization, signature), "InvalidSignature");
    assert_eq!(s.client.get_balance(&recipient)?, 0);
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn a_cold_signed_token_withdrawal_creates_the_destination_and_lands() -> Result<()> {
    let s = setup()?;
    let recipient = Keypair::new().pubkey();
    let mint = create_mint(&s.client, &s.relayer)?;
    let pda_account = mint_to(&s.client, &s.relayer, &mint, &s.pda, 1_000_000_000)?;
    let nonce = s.nonce()?;

    let execution = execution_message(
        &s.pda,
        &withdraw(&mint, &s.pda, &recipient, 250_000_000)?,
        nonce,
    )?;
    let authorization = authorization_message(
        &execution,
        &s.nonce_account,
        &s.pda,
        &[s.authority.pubkey()],
    )?;
    let signature = sign_authorization(&authorization, &s.authority);
    let predicted = next_nonce(&s.nonce_account, &execution);

    s.relay(&authorization, signature).unwrap();
    let recipient_account = associated_token_address(&recipient, &mint);
    assert_eq!(fetch_balance(&s.client, &recipient_account)?, 250_000_000);
    assert_eq!(fetch_balance(&s.client, &pda_account)?, 750_000_000);
    assert_eq!(s.nonce()?, predicted);
    assert_custom_error_3(s.relay(&authorization, signature), "NonceMismatch");
    Ok(())
}
