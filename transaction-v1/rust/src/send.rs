//! Building and sending transaction v1 messages.

use anyhow::{Context, Result};
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v1, Instruction, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

/// A compute budget that exercises all four `TransactionConfig` fields.
///
/// The heap size is deliberately not 32 KB, which is what an *unset* heap
/// resolves to and so would be indistinguishable from omitting the field.
pub const EXAMPLE_CONFIG: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(20_000)
    .with_loaded_accounts_data_size_limit(64 * 1024)
    .with_heap_size(64 * 1024)
    .with_priority_fee(5_000);

/// Creates a keypair funded by airdrop, waiting for the airdrop to confirm.
pub fn funded_keypair(client: &RpcClient, lamports: u64) -> Result<Keypair> {
    let payer = Keypair::new();
    let signature = client
        .request_airdrop(&payer.pubkey(), lamports)
        .context("airdrop request failed; is a local validator running?")?;
    let blockhash = client.get_latest_blockhash()?;
    client.confirm_transaction_with_spinner(
        &signature,
        &blockhash,
        CommitmentConfig::confirmed(),
    )?;
    Ok(payer)
}

/// Builds a signed v1 transaction.
///
/// `lifetime_specifier` is what v1 calls the recent blockhash slot: a blockhash
/// the transaction expires with, or a durable nonce when the first instruction
/// is `AdvanceNonceAccount`. `signers` must cover every signing account in
/// `instructions`, the payer included.
pub fn build_v1_transaction(
    payer: &Keypair,
    instructions: &[Instruction],
    lifetime_specifier: Hash,
    config: v1::TransactionConfig,
    signers: &[&Keypair],
) -> Result<VersionedTransaction> {
    let message = v1::Message::try_compile_with_config(
        &payer.pubkey(),
        instructions,
        lifetime_specifier,
        config,
    )?;
    Ok(VersionedTransaction::try_new(
        VersionedMessage::V1(message),
        signers,
    )?)
}

/// Builds a signed v1 SOL transfer.
///
/// The compute budget travels in the message's `TransactionConfig`, so the
/// instruction list holds only the transfer itself.
pub fn build_v1_transfer(
    payer: &Keypair,
    recipient: &Address,
    lamports: u64,
    blockhash: Hash,
    config: v1::TransactionConfig,
) -> Result<VersionedTransaction> {
    let instruction =
        solana_system_interface::instruction::transfer(&payer.pubkey(), recipient, lamports);
    build_v1_transaction(payer, &[instruction], blockhash, config, &[payer])
}
