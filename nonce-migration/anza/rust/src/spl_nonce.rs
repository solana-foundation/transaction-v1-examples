//! Creating and reading SPL nonce accounts, and predicting their next value.
//!
//! An SPL nonce account belongs to the Nonce program, not the System program.
//! It stores a value, an authority, and the slot it was created in. The value
//! is consumed by the executor on behalf of its authority, which for these
//! examples is the programmatic signer PDA.

use anyhow::{Context, Result};
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use spl_message_executor_interface::instruction::derive_transition_commitment;
use spl_nonce_interface::state::Nonce;

use crate::cluster::send_transaction;

/// Creates and initializes a nonce account for `authority`, paid for by `payer`.
///
/// Creation and initialization travel in one transaction so nothing can claim
/// the funded, uninitialized account in between. The authority does not sign;
/// it is only stored.
pub fn create_nonce_account(
    client: &RpcClient,
    payer: &Keypair,
    authority: &Address,
) -> Result<Address> {
    let nonce_account = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(Nonce::LEN)?;
    let instructions = spl_nonce_client::instruction::create_account(
        &payer.pubkey(),
        &nonce_account.pubkey(),
        authority,
        rent,
    );
    send_transaction(client, payer, &instructions, &[payer, &nonce_account])
        .context("failed to create the nonce account")?;
    Ok(nonce_account.pubkey())
}

/// Reads the current state of a nonce account.
pub fn fetch_nonce(client: &RpcClient, nonce_account: &Address) -> Result<Nonce> {
    let account = client
        .get_account(nonce_account)
        .with_context(|| format!("nonce account {nonce_account} not found"))?;
    let nonce = Nonce::view(&account.data).map_err(|error| {
        anyhow::anyhow!("{nonce_account} is not an initialized nonce account: {error:?}")
    })?;
    Ok(nonce.clone())
}

/// The value `nonce_account` will hold after `execution_message` runs.
///
/// A System nonce advances to an unpredictable future blockhash. An SPL nonce
/// advances to a hash of its current value and the message that ran, so the
/// signer knows the successor before anything is sent. That is what lets a
/// chain of actions be signed up front, each valid only after the one before.
pub fn next_nonce(nonce_account: &Address, execution_message: &v1::Message) -> Hash {
    Nonce {
        nonce: execution_message.lifetime_specifier,
        ..Nonce::default()
    }
    .derive_next_nonce(
        &spl_nonce_interface::ID,
        nonce_account,
        &derive_transition_commitment(&VersionedMessage::V1(execution_message.clone())),
    )
}
