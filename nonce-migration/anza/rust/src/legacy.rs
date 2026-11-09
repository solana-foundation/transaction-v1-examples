//! The flow being replaced: a System durable nonce transaction.
//!
//! Here for comparison. The cold key owns the funds, creates a nonce account
//! with the System program, and signs a transaction whose first instruction is
//! `AdvanceNonceAccount` and whose blockhash slot holds the nonce value. That
//! transaction is sent as-is, whenever.

use anyhow::{Context, Result};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_nonce_utils::data_from_account;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;

/// Creates a System nonce account whose authority is `cold`, paid for by `cold`.
pub fn create_system_nonce_account(client: &RpcClient, cold: &Keypair) -> Result<Address> {
    let nonce_account = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(solana_nonce::state::State::size())?;
    let instructions = system_instruction::create_nonce_account(
        &cold.pubkey(),
        &nonce_account.pubkey(),
        &cold.pubkey(),
        rent,
    );
    let blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&cold.pubkey()),
        &[cold, &nonce_account],
        blockhash,
    );
    client
        .send_and_confirm_transaction(&transaction)
        .context("failed to create the System nonce account")?;
    Ok(nonce_account.pubkey())
}

/// Reads the value a System nonce account currently holds.
pub fn fetch_system_nonce(client: &RpcClient, nonce_account: &Address) -> Result<Hash> {
    let account = client.get_account(nonce_account)?;
    let data = data_from_account(&account).context("not a System nonce account")?;
    Ok(data.durable_nonce.as_hash().to_owned())
}

/// Signs a durable nonce transfer from `cold`. Nothing is sent.
pub fn sign_durable_nonce_transfer(
    cold: &Keypair,
    nonce_account: &Address,
    nonce: Hash,
    recipient: &Address,
    lamports: u64,
) -> Transaction {
    let transfer = system_instruction::transfer(&cold.pubkey(), recipient, lamports);
    let message = Message::new_with_nonce(
        vec![transfer],
        Some(&cold.pubkey()),
        nonce_account,
        &cold.pubkey(),
    );
    let mut transaction = Transaction::new_unsigned(message);
    transaction.sign(&[cold], nonce);
    transaction
}
