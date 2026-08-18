//! Indexes transactions off a Yellowstone gRPC stream, isolating v1.
//!
//! `SubscribeRequestFilterTransactions` has no version field, so a consumer
//! subscribes to everything and discriminates on the presence of `config`.

use anyhow::Result;
use clap::Parser;
use futures::StreamExt;
use std::collections::HashMap;
use txv1::grpc::{describe_config, message_version};
use txv1::version::VersionTally;
use txv1::{ComputeBudget, MessageVersion, DEFAULT_GRPC_URL};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions,
};

#[derive(Parser)]
#[command(about = "Stream transactions over gRPC and decode v1 configs")]
struct Args {
    #[arg(long, env = "TXV1_GRPC_URL", default_value = DEFAULT_GRPC_URL)]
    grpc_url: String,

    /// Stop once this many v1 transactions have been seen.
    #[arg(long)]
    exit_after_v1: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let endpoint = args.grpc_url.clone();
    let mut client = GeyserGrpcClient::build_from_shared(args.grpc_url)?
        .connect()
        .await?;

    let request = SubscribeRequest {
        commitment: Some(CommitmentLevel::Confirmed as i32),
        transactions: HashMap::from([(
            "all".to_string(),
            SubscribeRequestFilterTransactions {
                failed: Some(false),
                vote: Some(false),
                ..Default::default()
            },
        )]),
        ..Default::default()
    };

    let mut stream = client.subscribe_once(request).await?;
    let mut tally = VersionTally::default();
    println!("subscribed to {endpoint}");

    while let Some(update) = stream.next().await {
        let Some(UpdateOneof::Transaction(update)) = update?.update_oneof else {
            continue;
        };
        let Some(info) = update.transaction else {
            continue;
        };
        let signature = bs58::encode(&info.signature).into_string();
        let Some(message) = info.transaction.and_then(|tx| tx.message) else {
            continue;
        };

        let version = message_version(&message);
        tally.record(version);

        // This is the line an existing indexer has to change: scanning
        // ComputeBudget instructions alone returns nothing for v1 without
        // erroring.
        let budget = ComputeBudget::of_message(&message);
        println!(
            "slot {} {version} cu_limit={} priority_fee={} lamports sig {signature}",
            update.slot,
            budget
                .compute_unit_limit
                .map_or_else(|| "-".to_string(), |limit| limit.to_string()),
            budget
                .priority_fee_lamports
                .map_or_else(|| "-".to_string(), |fee| fee.to_string()),
        );

        if version != MessageVersion::V1 {
            continue;
        }

        if let Some(config) = &message.config {
            println!("{}", describe_config(config, "  "));
        }
        // On v1 the wire's `recent_blockhash` slot carries the lifetime
        // specifier.
        println!(
            "  lifetime_specifier:              {}",
            bs58::encode(&message.recent_blockhash).into_string()
        );
        println!(
            "  address_table_lookups:           {} (v1 never has any)",
            message.address_table_lookups.len()
        );
        println!("  running tally:                   {tally}");

        if args.exit_after_v1.is_some_and(|limit| tally.v1 >= limit) {
            println!("\nreached the v1 limit, exiting");
            break;
        }
    }

    Ok(())
}
