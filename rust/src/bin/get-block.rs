//! Reads a block containing v1 transactions over JSON-RPC.
//!
//! When `maxSupportedTransactionVersion` is below the highest version present,
//! the whole request fails rather than degrading, so a caller pinned at 0 loses
//! entire blocks as soon as v1 traffic appears.

use anyhow::{Context, Result};
use clap::Parser;
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcBlockConfig;
use solana_signer::Signer;
use solana_transaction::versioned::TransactionVersion;
use solana_transaction_status_client_types::{
    EncodedTransaction, TransactionDetails, UiConfirmedBlock, UiMessage, UiTransactionEncoding,
};
use txv1::send::{build_v1_transfer, funded_keypair, EXAMPLE_CONFIG};
use txv1::version::VersionTally;
use txv1::{MessageVersion, DEFAULT_RPC_URL};

#[derive(Parser)]
#[command(about = "Fetch a block and tally its transaction versions")]
struct Args {
    #[arg(long, env = "TXV1_RPC_URL", default_value = DEFAULT_RPC_URL)]
    rpc_url: String,

    /// Slot to read. Defaults to the slot of a freshly sent v1 transaction.
    #[arg(long)]
    slot: Option<u64>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let client = RpcClient::new_with_commitment(args.rpc_url, CommitmentConfig::confirmed());

    let slot = match args.slot {
        Some(slot) => slot,
        None => send_v1_and_get_slot(&client)?,
    };
    println!("reading slot {slot}\n");

    println!("== maxSupportedTransactionVersion omitted ==");
    match client.get_block_with_config(slot, block_config(None)) {
        Ok(_) => println!("  succeeded: this block holds no versioned transactions"),
        Err(error) => println!("  rejected: {error}"),
    }

    println!("\n== maxSupportedTransactionVersion: 0 ==");
    match client.get_block_with_config(slot, block_config(Some(0))) {
        Ok(_) => println!("  succeeded: this block holds no v1 transactions"),
        Err(error) => println!("  rejected: {error}"),
    }

    println!("\n== maxSupportedTransactionVersion: 1 ==");
    let block = client
        .get_block_with_config(slot, block_config(Some(1)))
        .context("getBlock with maxSupportedTransactionVersion: 1 failed")?;
    report(&block);

    Ok(())
}

fn block_config(max_supported_transaction_version: Option<u8>) -> RpcBlockConfig {
    RpcBlockConfig {
        commitment: Some(CommitmentConfig::confirmed()),
        encoding: Some(UiTransactionEncoding::Json),
        max_supported_transaction_version,
        rewards: Some(false),
        transaction_details: Some(TransactionDetails::Full),
    }
}

fn send_v1_and_get_slot(client: &RpcClient) -> Result<u64> {
    let payer = funded_keypair(client, 1_000_000_000)?;
    let recipient = Keypair::new().pubkey();
    let blockhash = client.get_latest_blockhash()?;
    let transaction = build_v1_transfer(&payer, &recipient, 10_000_000, blockhash, EXAMPLE_CONFIG)?;
    let signature = client.send_and_confirm_transaction(&transaction)?;
    let statuses = client.get_signature_statuses(&[signature])?;
    let status = statuses
        .value
        .into_iter()
        .flatten()
        .next()
        .context("no status for the transaction just sent")?;
    Ok(status.slot)
}

fn report(block: &UiConfirmedBlock) {
    let Some(transactions) = &block.transactions else {
        println!("  block carried no transaction details");
        return;
    };

    let mut tally = VersionTally::default();
    let mut v1_lines = Vec::new();

    for transaction in transactions {
        // Unlike gRPC, JSON-RPC reports the version — but only because the
        // request opted in.
        let version = match transaction.version {
            Some(TransactionVersion::Number(1)) => MessageVersion::V1,
            Some(TransactionVersion::Number(0)) => MessageVersion::V0,
            Some(TransactionVersion::Number(other)) => {
                // Folding an unrecognised version into an existing bucket is
                // how v1 first shows up as v0 in an unprepared pipeline.
                println!("  warning: unrecognised transaction version {other}, not tallied");
                continue;
            }
            _ => MessageVersion::Legacy,
        };
        tally.record(version);

        if version != MessageVersion::V1 {
            continue;
        }
        let EncodedTransaction::Json(ui) = &transaction.transaction else {
            continue;
        };
        let config = match &ui.message {
            UiMessage::Raw(raw) => raw.transaction_config.as_ref(),
            UiMessage::Parsed(parsed) => parsed.transaction_config.as_ref(),
        };
        let signature = ui.signatures.first().map_or("?", String::as_str);
        v1_lines.push(match config {
            Some(config) => format!(
                "  {signature}\n    priority_fee={:?} compute_unit_limit={:?} \
                 loaded_accounts_data_size_limit={:?} heap_size={:?}",
                config.priority_fee,
                config.compute_unit_limit,
                config.loaded_accounts_data_size_limit,
                config.heap_size
            ),
            None => format!("  {signature}\n    no transactionConfig on a v1 transaction"),
        });
    }

    println!("  {} of {} transactions", tally, tally.total());
    for line in v1_lines {
        println!("{line}");
    }
}
