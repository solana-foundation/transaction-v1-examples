//! Tests that run against a live validator.
//!
//! These are `#[ignore]`d so `cargo test` stays offline by default. Run them
//! with `just test-live`, which starts a 4.2.1 validator with the Yellowstone
//! geyser plugin first.
//!
//! Endpoints come from `TXV1_RPC_URL` and `TXV1_GRPC_URL`.

use anyhow::Result;
use futures::StreamExt;
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::{RpcBlockConfig, RpcTransactionConfig};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::TransactionVersion;
use solana_transaction_status_client_types::{
    EncodedTransaction, TransactionDetails, UiMessage, UiTransactionEncoding,
};
use std::collections::HashMap;
use std::time::Duration;
use txv1::grpc::message_version;
use txv1::send::{build_v1_transfer, funded_keypair, EXAMPLE_CONFIG};
use txv1::{MessageVersion, DEFAULT_GRPC_URL, DEFAULT_RPC_URL};
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions,
};

fn rpc_url() -> String {
    std::env::var("TXV1_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string())
}

fn grpc_url() -> String {
    std::env::var("TXV1_GRPC_URL").unwrap_or_else(|_| DEFAULT_GRPC_URL.to_string())
}

fn client() -> RpcClient {
    RpcClient::new_with_commitment(rpc_url(), CommitmentConfig::confirmed())
}

fn send_v1(client: &RpcClient) -> Result<Signature> {
    let payer = funded_keypair(client, 1_000_000_000)?;
    let blockhash = client.get_latest_blockhash()?;
    let transaction = build_v1_transfer(
        &payer,
        &Keypair::new().pubkey(),
        10_000_000,
        blockhash,
        EXAMPLE_CONFIG,
    )?;
    Ok(client.send_and_confirm_transaction(&transaction)?)
}

fn transaction_config(
    client: &RpcClient,
    signature: &Signature,
    max_supported_transaction_version: Option<u8>,
) -> solana_rpc_client_api::client_error::Result<
    solana_transaction_status_client_types::EncodedConfirmedTransactionWithStatusMeta,
> {
    client.get_transaction_with_config(
        signature,
        RpcTransactionConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Json),
            max_supported_transaction_version,
        },
    )
}

#[test]
#[ignore = "requires a running validator"]
fn a_v1_transaction_lands_and_reports_version_1() -> Result<()> {
    let client = client();
    let signature = send_v1(&client)?;

    let fetched = transaction_config(&client, &signature, Some(1))?;
    assert_eq!(
        fetched.transaction.version,
        Some(TransactionVersion::Number(1))
    );
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn get_transaction_rejects_v1_when_the_version_ceiling_is_too_low() -> Result<()> {
    let client = client();
    let signature = send_v1(&client)?;

    for ceiling in [None, Some(0)] {
        let error = transaction_config(&client, &signature, ceiling)
            .expect_err("a v1 transaction must not be served below a v1 ceiling");
        assert!(
            error.to_string().contains("maxSupportedTransactionVersion"),
            "unexpected error for ceiling {ceiling:?}: {error}"
        );
    }
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn the_rpc_json_projection_carries_the_transaction_config() -> Result<()> {
    let client = client();
    let signature = send_v1(&client)?;

    let fetched = transaction_config(&client, &signature, Some(1))?;
    let EncodedTransaction::Json(ui) = &fetched.transaction.transaction else {
        panic!("expected a JSON-encoded transaction");
    };
    let config = match &ui.message {
        UiMessage::Parsed(parsed) => parsed.transaction_config.as_ref(),
        UiMessage::Raw(raw) => raw.transaction_config.as_ref(),
    }
    .expect("a v1 transaction must expose transactionConfig");

    assert_eq!(config.priority_fee, EXAMPLE_CONFIG.priority_fee);
    assert_eq!(config.compute_unit_limit, EXAMPLE_CONFIG.compute_unit_limit);
    assert_eq!(
        config.loaded_accounts_data_size_limit,
        EXAMPLE_CONFIG.loaded_accounts_data_size_limit
    );
    assert_eq!(config.heap_size, EXAMPLE_CONFIG.heap_size);
    Ok(())
}

#[test]
#[ignore = "requires a running validator"]
fn get_block_fails_entirely_when_a_v1_transaction_is_present() -> Result<()> {
    let client = client();
    let signature = send_v1(&client)?;
    let slot = client
        .get_signature_statuses(&[signature])?
        .value
        .into_iter()
        .flatten()
        .next()
        .expect("status for the transaction just sent")
        .slot;

    let config = |max: Option<u8>| RpcBlockConfig {
        commitment: Some(CommitmentConfig::confirmed()),
        encoding: Some(UiTransactionEncoding::Json),
        max_supported_transaction_version: max,
        rewards: Some(false),
        transaction_details: Some(TransactionDetails::Full),
    };

    // The whole block is refused, not just the v1 transaction inside it.
    let error = client
        .get_block_with_config(slot, config(Some(0)))
        .expect_err("a block holding a v1 transaction must not be served at a v0 ceiling");
    assert!(
        error.to_string().contains("maxSupportedTransactionVersion"),
        "expected a version-ceiling rejection, got: {error}"
    );

    let block = client.get_block_with_config(slot, config(Some(1)))?;
    let transactions = block.transactions.expect("transaction details requested");
    assert!(
        transactions
            .iter()
            .any(|tx| tx.version == Some(TransactionVersion::Number(1))),
        "the block must contain the v1 transaction just sent"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires a running validator with the Yellowstone geyser plugin"]
async fn the_grpc_stream_delivers_the_v1_config_intact() -> Result<()> {
    let mut grpc = GeyserGrpcClient::build_from_shared(grpc_url())?
        .connect()
        .await?;
    let mut stream = grpc
        .subscribe_once(SubscribeRequest {
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
        })
        .await?;

    let sender = tokio::task::spawn_blocking(|| send_v1(&client()));

    let found = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(update) = stream.next().await {
            let Some(UpdateOneof::Transaction(update)) = update?.update_oneof else {
                continue;
            };
            let Some(message) = update
                .transaction
                .and_then(|info| info.transaction)
                .and_then(|tx| tx.message)
            else {
                continue;
            };
            if message_version(&message) == MessageVersion::V1 {
                return anyhow::Ok(message);
            }
        }
        anyhow::bail!("stream ended before a v1 transaction arrived")
    })
    .await??;

    sender.await??;

    assert!(
        found.versioned,
        "`versioned` is true for v1 as well as v0, which is why it cannot pick a version"
    );

    let config = found.config.expect("v1 messages carry a config");
    assert_eq!(config.priority_fee, EXAMPLE_CONFIG.priority_fee);
    assert_eq!(config.compute_unit_limit, EXAMPLE_CONFIG.compute_unit_limit);
    assert_eq!(
        config.loaded_accounts_data_size_limit,
        EXAMPLE_CONFIG.loaded_accounts_data_size_limit
    );
    assert_eq!(config.heap_size, EXAMPLE_CONFIG.heap_size);
    assert!(
        found.address_table_lookups.is_empty(),
        "v1 has no address lookup tables"
    );
    Ok(())
}
