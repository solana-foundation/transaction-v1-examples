//! Sends a transaction v1 transfer to a validator and decodes it back.
//!
//! Recovers the config from both the raw wire bytes and the RPC's JSON
//! projection.

use anyhow::{bail, Context, Result};
use clap::Parser;
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcTransactionConfig;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_status_client_types::{
    EncodedTransaction, UiMessage, UiTransactionEncoding,
};
use txv1::send::funded_keypair;
use txv1::{is_v1_active, DEFAULT_RPC_URL, ENABLE_TX_V1_FEATURE};

#[derive(Parser)]
#[command(about = "Send a v1 transaction and decode it back off the wire")]
struct Args {
    #[arg(long, env = "TXV1_RPC_URL", default_value = DEFAULT_RPC_URL)]
    rpc_url: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let client = RpcClient::new_with_commitment(args.rpc_url, CommitmentConfig::confirmed());

    if !is_v1_active(&client)? {
        bail!(
            "enable_tx_v1 ({ENABLE_TX_V1_FEATURE}) is not activated on this cluster; \
             a v1 transaction would be rejected"
        );
    }

    let payer = funded_keypair(&client, 1_000_000_000)?;
    let recipient = Keypair::new().pubkey();

    // The compute budget is a property of the message, so the instruction list
    // holds only the transfer. Every field is optional, but an unset limit
    // resolves to zero, so a real transaction sets them explicitly.
    let config = v1::TransactionConfig::empty()
        .with_compute_unit_limit(20_000)
        .with_loaded_accounts_data_size_limit(64 * 1024)
        .with_heap_size(64 * 1024)
        // A total in lamports, not micro-lamports per compute unit.
        .with_priority_fee(5_000);

    let instruction =
        solana_system_interface::instruction::transfer(&payer.pubkey(), &recipient, 10_000_000);

    let blockhash = client.get_latest_blockhash()?;
    let message =
        v1::Message::try_compile_with_config(&payer.pubkey(), &[instruction], blockhash, config)?;
    let transaction = VersionedTransaction::try_new(VersionedMessage::V1(message), &[&payer])?;

    let VersionedMessage::V1(message) = &transaction.message else {
        bail!("expected a v1 message");
    };
    let wire = message.serialize();
    println!("== compiled locally ==");
    println!("  message bytes:      {}", wire.len());
    println!("  version prefix:     0x{:02x}", wire[0]);
    println!("  instructions:       {}", message.instructions.len());
    println!("  lifetime_specifier: {}", message.lifetime_specifier);
    println!("{}", describe(&message.config));

    let signature = client.send_and_confirm_transaction(&transaction)?;
    println!("\n== sent ==\n  signature: {signature}");

    // Without `max_supported_transaction_version` the caller is capped at
    // legacy, and the server refuses outright rather than degrading.
    let unversioned = client.get_transaction_with_config(
        &signature,
        RpcTransactionConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Base64),
            max_supported_transaction_version: None,
        },
    );
    println!("\n== getTransaction without maxSupportedTransactionVersion ==");
    match unversioned {
        Ok(_) => println!("  unexpectedly succeeded"),
        Err(error) => println!("  rejected: {error}"),
    }

    let fetched = client
        .get_transaction_with_config(
            &signature,
            RpcTransactionConfig {
                commitment: Some(CommitmentConfig::confirmed()),
                encoding: Some(UiTransactionEncoding::Base64),
                max_supported_transaction_version: Some(1),
            },
        )
        .context("getTransaction with maxSupportedTransactionVersion: 1 failed")?;

    let decoded = fetched
        .transaction
        .transaction
        .decode()
        .context("failed to decode the base64 transaction")?;
    let VersionedMessage::V1(decoded_message) = &decoded.message else {
        bail!("round trip did not produce a v1 message");
    };

    println!("\n== decoded from base64 wire bytes ==");
    println!("  version:            {:?}", fetched.transaction.version);
    println!(
        "  lifetime_specifier: {}",
        decoded_message.lifetime_specifier
    );
    println!("{}", describe(&decoded_message.config));

    if decoded_message.config != config {
        bail!("config did not survive the round trip");
    }
    println!("  config round-tripped exactly");

    let json = client.get_transaction_with_config(
        &signature,
        RpcTransactionConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Json),
            max_supported_transaction_version: Some(1),
        },
    )?;
    println!("\n== the same config as the RPC's JSON projection ==");
    let EncodedTransaction::Json(ui) = &json.transaction.transaction else {
        bail!("expected a JSON-encoded transaction");
    };
    let json_config = match &ui.message {
        UiMessage::Raw(raw) => raw.transaction_config.as_ref(),
        UiMessage::Parsed(parsed) => parsed.transaction_config.as_ref(),
    };
    println!(
        "  message.transactionConfig: {}",
        serde_json::to_string(&json_config)?
    );

    Ok(())
}

fn describe(config: &v1::TransactionConfig) -> String {
    format!(
        "  priority_fee:       {:?} (total lamports, not micro-lamports/CU)\n  \
         compute_unit_limit: {:?}\n  \
         loaded_accounts:    {:?}\n  \
         heap_size:          {:?}",
        config.priority_fee,
        config.compute_unit_limit,
        config.loaded_accounts_data_size_limit,
        config.heap_size,
    )
}
