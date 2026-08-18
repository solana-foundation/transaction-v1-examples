//! Checking whether transaction v1 is live on a cluster.

use anyhow::{Context, Result};
use solana_address::{address, Address};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::rpc_client::RpcClient;

/// The feature gate that activates transaction v1.
pub const ENABLE_TX_V1_FEATURE: Address = address!("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL");

/// Reports whether `enable_tx_v1` is activated on the cluster behind `client`.
///
/// An absent account and a staged-but-inactive one both mean a v1 transaction
/// would be rejected, so both answer `false`.
pub fn is_v1_active(client: &RpcClient) -> Result<bool> {
    let account = client
        .get_account_with_commitment(&ENABLE_TX_V1_FEATURE, CommitmentConfig::confirmed())
        .context("failed to read the enable_tx_v1 feature account")?
        .value;

    Ok(account
        .and_then(|account| solana_feature_gate_interface::from_account(&account))
        .is_some_and(|feature| feature.activated_at.is_some()))
}
