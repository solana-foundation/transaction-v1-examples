//! Sends a transaction v1 transfer whose lifetime comes from a durable nonce.
//!
//! A durable nonce replaces the recent blockhash with a value stored in an
//! on-chain account, so the transaction stays valid until that nonce advances
//! rather than expiring after ~150 slots. Nothing about that mechanism changes
//! on v1: the nonce still travels in the message's blockhash slot — which v1
//! names `lifetime_specifier` — and the compute budget still travels in the v1
//! config alongside it.
//!
//! Run with `just nonce`.

use anyhow::{bail, Context, Result};
use clap::Parser;
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_nonce::state::State;
use solana_nonce::versions::Versions;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::RpcTransactionConfig;
use solana_signer::Signer;
use solana_system_interface::instruction::{advance_nonce_account, create_nonce_account, transfer};
use solana_transaction_status_client_types::{
    EncodedTransaction, UiMessage, UiTransactionEncoding,
};
use txv1::send::{build_v1_transaction, funded_keypair, EXAMPLE_CONFIG};
use txv1::{is_v1_active, ComputeBudget, MessageVersion, DEFAULT_RPC_URL, ENABLE_TX_V1_FEATURE};

#[derive(Parser)]
#[command(about = "Send a v1 transaction under a durable nonce lifetime and read it back")]
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
    let nonce_account = Keypair::new();
    let recipient = Keypair::new().pubkey();

    // Creating the nonce account is an ordinary blockhash-lifetime transaction.
    // It is v1 too, so it has to state its limits; the payer is also the nonce
    // authority, and the new account signs for its own creation.
    let rent = client.get_minimum_balance_for_rent_exemption(State::size())?;
    let blockhash = client.get_latest_blockhash()?;
    let setup = build_v1_transaction(
        &payer,
        &create_nonce_account(
            &payer.pubkey(),
            &nonce_account.pubkey(),
            &payer.pubkey(),
            rent,
        ),
        blockhash,
        v1::TransactionConfig::empty()
            .with_compute_unit_limit(20_000)
            .with_loaded_accounts_data_size_limit(64 * 1024),
        &[&payer, &nonce_account],
    )?;
    client.send_and_confirm_transaction(&setup)?;
    println!(
        "== nonce account created ==\n  address: {}",
        nonce_account.pubkey()
    );

    let nonce = read_nonce(&client, &nonce_account.pubkey())?;
    println!("  nonce:   {nonce}");

    // The nonce takes the blockhash's place, and `AdvanceNonceAccount` has to
    // be the first instruction: that is how the runtime — and the RPC client's
    // confirmation loop — recognise a durable transaction.
    let transaction = build_v1_transaction(
        &payer,
        &[
            advance_nonce_account(&nonce_account.pubkey(), &payer.pubkey()),
            transfer(&payer.pubkey(), &recipient, 10_000_000),
        ],
        nonce,
        EXAMPLE_CONFIG,
        &[&payer],
    )?;
    let VersionedMessage::V1(message) = &transaction.message else {
        bail!("expected a v1 message");
    };

    println!("\n== compiled locally ==");
    println!(
        "  version:            {}",
        MessageVersion::from(&transaction.message)
    );
    println!(
        "  lifetime_specifier: {} (the nonce)",
        message.lifetime_specifier
    );
    println!(
        "  instructions:       {} (AdvanceNonceAccount, then the transfer)",
        message.instructions.len()
    );
    println!("{}", ComputeBudget::from(&message.config).describe("  "));

    // `send_and_confirm_transaction` sees the advance instruction and tracks
    // expiry against a fresh blockhash rather than the nonce, which is not one.
    let signature = client.send_and_confirm_transaction(&transaction)?;
    println!("\n== sent ==\n  signature: {signature}");

    let json = client
        .get_transaction_with_config(
            &signature,
            RpcTransactionConfig {
                commitment: Some(CommitmentConfig::confirmed()),
                encoding: Some(UiTransactionEncoding::Json),
                max_supported_transaction_version: Some(1),
            },
        )
        .context("getTransaction with maxSupportedTransactionVersion: 1 failed")?;
    let EncodedTransaction::Json(ui) = &json.transaction.transaction else {
        bail!("expected a JSON-encoded transaction");
    };
    let recent_blockhash = match &ui.message {
        UiMessage::Raw(raw) => &raw.recent_blockhash,
        UiMessage::Parsed(parsed) => &parsed.recent_blockhash,
    };
    println!("\n== read back over JSON-RPC ==");
    println!("  version:         {:?}", json.transaction.version);
    println!("  recentBlockhash: {recent_blockhash} (the nonce, not a blockhash)");

    let encoded = client.get_transaction_with_config(
        &signature,
        RpcTransactionConfig {
            commitment: Some(CommitmentConfig::confirmed()),
            encoding: Some(UiTransactionEncoding::Base64),
            max_supported_transaction_version: Some(1),
        },
    )?;
    let decoded = encoded
        .transaction
        .transaction
        .decode()
        .context("failed to decode the base64 transaction")?;
    let VersionedMessage::V1(remote) = &decoded.message else {
        bail!("round trip did not produce a v1 message");
    };
    println!("{}", ComputeBudget::from(&remote.config).describe("  "));
    if remote.config != EXAMPLE_CONFIG {
        bail!("the config did not survive the round trip");
    }
    println!("  config round-tripped exactly");

    let advanced = read_nonce(&client, &nonce_account.pubkey())?;
    println!("\n== nonce after the transaction ==");
    println!("  before: {nonce}");
    println!("  after:  {advanced}");
    if advanced == nonce {
        bail!("the nonce did not advance");
    }

    Ok(())
}

/// Reads the current nonce value out of a nonce account.
///
/// The account holds a bincode `Versions` wrapping the nonce `State`; the hash
/// in its initialized data is what goes in the transaction's blockhash slot.
fn read_nonce(client: &RpcClient, nonce_account: &Address) -> Result<Hash> {
    let account = client
        .get_account(nonce_account)
        .context("failed to read the nonce account")?;
    let versions: Versions =
        bincode::deserialize(&account.data).context("the nonce account data did not parse")?;
    match versions.state() {
        State::Initialized(data) => Ok(data.blockhash()),
        State::Uninitialized => bail!("nonce account {nonce_account} is not initialized"),
    }
}
