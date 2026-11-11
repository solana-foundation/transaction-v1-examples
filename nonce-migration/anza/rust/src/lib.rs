//! Shared helpers for the programmatic signer examples.
//!
//! The programmatic signer replaces a durable nonce transaction with three
//! nested messages. The cold key signs an *authorization message* that wraps an
//! *execution message*, and a hot relayer wraps the authorization in a *relay
//! transaction* with a fresh blockhash. The Anza client crates build most of
//! that; the modules here hold what they lack, plus setup for the examples.

pub mod cluster;
pub mod durable_nonce;
pub mod signer;
pub mod spl_nonce;
pub mod token;

/// Default JSON-RPC endpoint of a local `solana-test-validator`.
pub const DEFAULT_RPC_URL: &str = "http://127.0.0.1:8899";
