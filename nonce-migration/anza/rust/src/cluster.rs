//! Connecting to a cluster, funding keys, sending setup transactions, and
//! checking the programs are there.

use anyhow::{bail, Context, Result};
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcTransactionConfig;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_status_client_types::option_serializer::OptionSerializer;
use solana_transaction_status_client_types::UiTransactionEncoding;
use std::thread::sleep;
use std::time::Duration;

/// The budget every transaction the examples send requests.
///
/// Unset v1 limits are zero, not the legacy defaults, so each transaction
/// states them. The largest is the relay of a token transfer: the Signer and
/// Executor programs, one promoted PDA, and the action cost about 98,000
/// compute units, against about 54,000 for a SOL transfer.
const TRANSACTION_CONFIG: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(200_000)
    .with_loaded_accounts_data_size_limit(4 * 1024 * 1024);

/// The three programs the examples call, with the names their crates use.
pub const PROGRAMS: [(&str, Address); 3] = [
    ("SPL Nonce", spl_nonce_interface::ID),
    ("SPL Ed25519 Signer", spl_ed25519_signer_client::ID),
    ("SPL Message Executor", spl_message_executor_interface::ID),
];

/// Connects at `confirmed` commitment, which every example and test uses.
pub fn client(rpc_url: &str) -> RpcClient {
    RpcClient::new_with_commitment(rpc_url.to_string(), CommitmentConfig::confirmed())
}

/// Throws unless all three programs are deployed on the cluster behind `client`.
///
/// Checked up front so a validator started without them names itself, rather
/// than surfacing later as a `ProgramAccountNotFound` on the relay.
pub fn assert_programs_deployed(client: &RpcClient) -> Result<()> {
    for (name, program_id) in PROGRAMS {
        let executable = client
            .get_account(&program_id)
            .map(|account| account.executable)
            .unwrap_or(false);
        if !executable {
            bail!(
                "the {name} program ({program_id}) is not deployed on this cluster; \
                 start a validator with `just validator-start`"
            );
        }
    }
    Ok(())
}

/// Creates a keypair funded by airdrop, waiting for the airdrop to confirm.
pub fn funded_keypair(client: &RpcClient, lamports: u64) -> Result<Keypair> {
    let keypair = Keypair::new();
    let signature = client
        .request_airdrop(&keypair.pubkey(), lamports)
        .context("airdrop request failed; is a local validator running?")?;
    let blockhash = client.get_latest_blockhash()?;
    client.confirm_transaction_with_spinner(
        &signature,
        &blockhash,
        CommitmentConfig::confirmed(),
    )?;
    Ok(keypair)
}

/// Sends `instructions` in one v1 transaction paid by `payer`, signed by
/// `signers`, and waits for it to confirm. Setup steps and the relay both go
/// through here: the relay is one `Submit` instruction from a hot key.
pub fn send_transaction(
    client: &RpcClient,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<Signature> {
    let message = v1::Message::try_compile_with_config(
        &payer.pubkey(),
        instructions,
        client.get_latest_blockhash()?,
        TRANSACTION_CONFIG,
    )
    .context("failed to compile the transaction")?;
    let transaction = VersionedTransaction::try_new(VersionedMessage::V1(message), signers)?;
    Ok(client.send_and_confirm_transaction(&transaction)?)
}

/// Blocks until `blockhash` can no longer be used in a transaction.
///
/// A blockhash lives for 150 slots, about a minute on a local validator. The
/// examples capture one when the cold key signs and wait it out before
/// relaying, which is the shortest demonstration that the signed artifact does
/// not expire with it.
pub fn wait_for_blockhash_expiry(client: &RpcClient, blockhash: &Hash) -> Result<()> {
    loop {
        if !client.is_blockhash_valid(blockhash, CommitmentConfig::confirmed())? {
            return Ok(());
        }
        sleep(Duration::from_secs(2));
    }
}

/// The compute units a confirmed transaction consumed, if the RPC reports them.
pub fn compute_units(client: &RpcClient, signature: &Signature) -> Result<Option<u64>> {
    let fetched = client.get_transaction_with_config(
        signature,
        RpcTransactionConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Json),
            max_supported_transaction_version: Some(1),
        },
    )?;
    Ok(
        match fetched
            .transaction
            .meta
            .map(|meta| meta.compute_units_consumed)
        {
            Some(OptionSerializer::Some(units)) => Some(units),
            _ => None,
        },
    )
}
