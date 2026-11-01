//! Sizes a v1 transaction's resource limits by simulation instead of guessing.
//!
//! v1 has no 200,000-CUs-per-instruction fallback: an unset compute unit limit
//! or loaded accounts data size limit resolves to zero, so every v1 transaction
//! has to state both. Simulating with both raised to the runtime maximum
//! measures what the transaction needs, and on v1 the measured limits are
//! written into the config rather than into ComputeBudget instructions.
//!
//! `@solana/kit` ships this as `estimateResourceLimitsFactory`; the Rust SDK
//! has no equivalent yet, so [`estimate_resource_limits`] does the same by
//! hand.

use anyhow::{bail, Context, Result};
use clap::Parser;
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v1, Instruction, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::{RpcSimulateTransactionConfig, RpcTransactionConfig};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_status_client_types::UiTransactionEncoding;
use txv1::budget::{MAX_COMPUTE_UNIT_LIMIT, MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT};
use txv1::send::{build_v1_transaction, funded_keypair};
use txv1::{is_v1_active, ComputeBudget, DEFAULT_RPC_URL, ENABLE_TX_V1_FEATURE};

#[derive(Parser)]
#[command(about = "Size a v1 transaction's compute budget by simulation")]
struct Args {
    #[arg(long, env = "TXV1_RPC_URL", default_value = DEFAULT_RPC_URL)]
    rpc_url: String,
}

/// What one simulated run of a transaction consumed.
#[derive(Clone, Copy, Debug)]
struct ResourceLimits {
    compute_unit_limit: u32,
    loaded_accounts_data_size_limit: u32,
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
    let instruction =
        solana_system_interface::instruction::transfer(&payer.pubkey(), &recipient, 10_000_000);
    let blockhash = client.get_latest_blockhash()?;

    // The priority fee is a pricing decision, not something simulation can
    // measure, so only the two resource limits are estimated below. Zero is a
    // provisory placeholder: it keeps both fields present, so the message
    // simulates at its final size, while marking them as not yet chosen.
    let draft = v1::TransactionConfig::empty()
        .with_priority_fee(5_000)
        .with_compute_unit_limit(0)
        .with_loaded_accounts_data_size_limit(0);

    println!("== before estimation ==");
    println!("{}", ComputeBudget::from(&draft).describe("  "));

    let estimate = estimate_resource_limits(
        &client,
        &payer.pubkey(),
        std::slice::from_ref(&instruction),
        blockhash,
        draft,
    )?;

    println!("\n== simulated ==");
    println!(
        "  compute_unit_limit:              {}",
        estimate.compute_unit_limit
    );
    // v1 requires this limit, so the estimate fails if the RPC withholds it; on
    // legacy and v0 it would only be advisory.
    println!(
        "  loaded_accounts_data_size_limit: {}",
        estimate.loaded_accounts_data_size_limit
    );

    // The setters overwrite the provisory placeholders with the measured
    // figures; the priority fee set above is left alone.
    let config = draft
        .with_compute_unit_limit(estimate.compute_unit_limit)
        .with_loaded_accounts_data_size_limit(estimate.loaded_accounts_data_size_limit);

    println!("\n== after estimation ==");
    println!("{}", ComputeBudget::from(&config).describe("  "));

    let transaction = build_v1_transaction(&payer, &[instruction], blockhash, config, &[&payer])?;
    let signature = client.send_and_confirm_transaction(&transaction)?;
    println!("\n== sent ==\n  signature: {signature}");

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
    let consumed: Option<u64> = fetched
        .transaction
        .meta
        .and_then(|meta| meta.compute_units_consumed.into());

    // These two numbers are equal: the estimate is the exact cost of one
    // simulated run, with nothing to spare. The simulation returns the measured
    // figure rather than padding it, so choosing a margin — `limit * 11 / 10`
    // or similar — is the caller's job.
    println!("\n== consumed on chain ==");
    println!(
        "  compute_units_consumed: {}",
        consumed.map_or_else(|| "not reported".to_string(), |units| units.to_string())
    );
    println!("  estimated limit:        {}", estimate.compute_unit_limit);
    println!("  the limit is the measured cost exactly — add margin before doing this for real");

    Ok(())
}

/// Measures the resource limits `instructions` need by simulating them once.
///
/// Simulation runs with both limits raised to the runtime maximum, so it cannot
/// fail for want of the resources it is measuring. The transaction is left
/// unsigned and the RPC is asked to swap in a current blockhash, so neither a
/// signer nor a fresh blockhash is needed to estimate.
fn estimate_resource_limits(
    client: &RpcClient,
    payer: &Address,
    instructions: &[Instruction],
    blockhash: Hash,
    config: v1::TransactionConfig,
) -> Result<ResourceLimits> {
    let message = v1::Message::try_compile_with_config(
        payer,
        instructions,
        blockhash,
        config
            .with_compute_unit_limit(MAX_COMPUTE_UNIT_LIMIT)
            .with_loaded_accounts_data_size_limit(MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT),
    )?;
    let transaction = VersionedTransaction {
        signatures: vec![Signature::default(); usize::from(message.header.num_required_signatures)],
        message: VersionedMessage::V1(message),
    };

    let simulation = client
        .simulate_transaction_with_config(
            &transaction,
            RpcSimulateTransactionConfig {
                sig_verify: false,
                replace_recent_blockhash: true,
                commitment: Some(CommitmentConfig::confirmed()),
                encoding: Some(UiTransactionEncoding::Base64),
                ..RpcSimulateTransactionConfig::default()
            },
        )
        .context("simulateTransaction failed")?
        .value;

    if let Some(error) = simulation.err {
        bail!(
            "the simulation failed: {error:?}\n{}",
            simulation.logs.unwrap_or_default().join("\n")
        );
    }
    let units_consumed = simulation
        .units_consumed
        .context("the RPC reported no unitsConsumed")?;
    // v1 cannot fall back to a default here, so an RPC that withholds the
    // figure is an error rather than an unset field.
    let loaded_accounts_data_size_limit = simulation.loaded_accounts_data_size.context(
        "the RPC reported no loadedAccountsDataSize, which a v1 transaction cannot do without",
    )?;

    Ok(ResourceLimits {
        compute_unit_limit: u32::try_from(units_consumed).unwrap_or(u32::MAX),
        loaded_accounts_data_size_limit,
    })
}
