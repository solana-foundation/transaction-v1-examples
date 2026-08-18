//! Indexes whole blocks off a Yellowstone gRPC stream, tallying versions.
//!
//! Unlike `getBlock` there is no ceiling to opt into and no error when v1
//! appears: the block arrives, and an unprepared consumer counts v1 as v0.

use anyhow::Result;
use clap::Parser;
use futures::StreamExt;
use std::collections::HashMap;
use txv1::grpc::{describe_config, message_version};
use txv1::version::VersionTally;
use txv1::{ComputeBudget, MessageVersion, DEFAULT_GRPC_URL};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest, SubscribeRequestFilterBlocks,
};

#[derive(Parser)]
#[command(about = "Stream blocks over gRPC and tally transaction versions")]
struct Args {
    #[arg(long, env = "TXV1_GRPC_URL", default_value = DEFAULT_GRPC_URL)]
    grpc_url: String,

    /// Stop once this many blocks containing a v1 transaction have been seen.
    #[arg(long)]
    exit_after_v1_blocks: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let endpoint = args.grpc_url.clone();
    let mut client = GeyserGrpcClient::build_from_shared(args.grpc_url)?
        .connect()
        .await?;

    let request = SubscribeRequest {
        blocks: HashMap::from([(
            "all".to_string(),
            SubscribeRequestFilterBlocks {
                include_transactions: Some(true),
                ..Default::default()
            },
        )]),
        commitment: Some(CommitmentLevel::Confirmed as i32),
        ..Default::default()
    };

    let mut stream = client.subscribe_once(request).await?;
    let mut blocks_with_v1 = 0u64;
    println!("subscribed to {endpoint}");

    while let Some(update) = stream.next().await {
        let Some(UpdateOneof::Block(block)) = update?.update_oneof else {
            continue;
        };

        let mut tally = VersionTally::default();
        let mut v1_transactions = Vec::new();
        let mut priority_fee_lamports = 0u64;

        for transaction in &block.transactions {
            let Some(message) = transaction
                .transaction
                .as_ref()
                .and_then(|tx| tx.message.as_ref())
            else {
                continue;
            };
            let version = message_version(message);
            tally.record(version);
            // Summing across versions only works because the budget accessor
            // normalises v0's micro-lamports-per-CU price into a total.
            priority_fee_lamports = priority_fee_lamports.saturating_add(
                ComputeBudget::of_message(message)
                    .priority_fee_lamports
                    .unwrap_or(0),
            );
            if version == MessageVersion::V1 {
                v1_transactions.push((
                    bs58::encode(&transaction.signature).into_string(),
                    message.config,
                ));
            }
        }

        println!(
            "slot {} ({} txs): {tally} priority_fees={priority_fee_lamports} lamports",
            block.slot, block.executed_transaction_count
        );
        for (signature, config) in &v1_transactions {
            println!("  v1 {signature}");
            if let Some(config) = config {
                println!("{}", describe_config(config, "    "));
            }
        }

        if !v1_transactions.is_empty() {
            blocks_with_v1 += 1;
            if args
                .exit_after_v1_blocks
                .is_some_and(|limit| blocks_with_v1 >= limit)
            {
                println!("\nreached the v1 block limit, exiting");
                break;
            }
        }
    }

    Ok(())
}
