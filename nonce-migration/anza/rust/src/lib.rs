//! Shared helpers for the programmatic signer examples.
//!
//! The programmatic signer replaces a durable nonce transaction with three
//! nested messages. The cold key signs an *authorization message* that wraps an
//! *execution message*, and a hot relayer wraps the authorization in a *relay
//! transaction* with a fresh blockhash. The helpers here build each layer the
//! way the Anza CLI does, so the examples stay short and the layers stay
//! visible.

pub mod cluster;
pub mod legacy;
pub mod nonce;
pub mod signer;
pub mod token;

pub use signer::programmatic_signer;

/// Default JSON-RPC endpoint of a local `solana-test-validator`.
pub const DEFAULT_RPC_URL: &str = "http://127.0.0.1:8899";
