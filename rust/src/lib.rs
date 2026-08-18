//! Shared helpers for the transaction v1 (SIMD-0385) examples.
//!
//! v1 moves the compute budget out of ComputeBudget program instructions and
//! into a `TransactionConfig` on the message. The helpers here cover the two
//! things that are easy to get wrong: identifying a v1 message, and reading its
//! config.

pub mod budget;
pub mod feature;
pub mod grpc;
pub mod send;
pub mod version;

pub use budget::ComputeBudget;
pub use feature::{is_v1_active, ENABLE_TX_V1_FEATURE};
pub use version::MessageVersion;

/// Default JSON-RPC endpoint of a local `solana-test-validator`.
pub const DEFAULT_RPC_URL: &str = "http://127.0.0.1:8899";

/// Default endpoint of a local Yellowstone gRPC geyser plugin.
pub const DEFAULT_GRPC_URL: &str = "http://127.0.0.1:10000";
