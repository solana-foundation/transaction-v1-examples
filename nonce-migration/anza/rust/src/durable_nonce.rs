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
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_nonce_utils::data_from_account;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;

use crate::cluster::send_transaction;

/// Creates a System nonce account whose authority is `cold`, paid for by `cold`.
pub fn create_durable_nonce_account(client: &RpcClient, cold: &Keypair) -> Result<Address> {
    let nonce_account = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(solana_nonce::state::State::size())?;
    let instructions = system_instruction::create_nonce_account(
        &cold.pubkey(),
        &nonce_account.pubkey(),
        &cold.pubkey(),
        rent,
    );
    send_transaction(client, cold, &instructions, &[cold, &nonce_account])
        .context("failed to create the System nonce account")?;
    Ok(nonce_account.pubkey())
}

/// Reads the value a System nonce account currently holds.
pub fn fetch_durable_nonce(client: &RpcClient, nonce_account: &Address) -> Result<Hash> {
    let account = client.get_account(nonce_account)?;
    let data = data_from_account(&account).context("not a System nonce account")?;
    Ok(data.durable_nonce.as_hash().to_owned())
}

/// The budget of the durable nonce transfer: two System instructions cost 300
/// compute units, and the cold key is offline and cannot simulate.
const DURABLE_NONCE_CONFIG: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(1_000)
    .with_loaded_accounts_data_size_limit(64 * 1024);

/// Signs a durable nonce transfer from `cold`. Nothing is sent.
///
/// The message is v1, and a durable nonce works on it as it does on a legacy
/// one: the nonce sits in the blockhash slot and `AdvanceNonceAccount` comes
/// first.
pub fn sign_durable_nonce_transfer(
    cold: &Keypair,
    nonce_account: &Address,
    nonce: Hash,
    recipient: &Address,
    lamports: u64,
) -> Result<VersionedTransaction> {
    let instructions = [
        system_instruction::advance_nonce_account(nonce_account, &cold.pubkey()),
        system_instruction::transfer(&cold.pubkey(), recipient, lamports),
    ];
    let message = v1::Message::try_compile_with_config(
        &cold.pubkey(),
        &instructions,
        nonce,
        DURABLE_NONCE_CONFIG,
    )
    .context("failed to compile the durable nonce transaction")?;
    Ok(VersionedTransaction::try_new(
        VersionedMessage::V1(message),
        &[cold],
    )?)
}
