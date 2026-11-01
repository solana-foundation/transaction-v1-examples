//! Reading transaction versions and v1 configs off the Yellowstone gRPC wire.
//!
//! gRPC has no equivalent of `maxSupportedTransactionVersion`: no opt-in, no
//! version field, no server-side filter. Once the gate activates, v1 arrives
//! whether the consumer understands it or not.

use crate::MessageVersion;
use yellowstone_grpc_proto::solana::storage::confirmed_block::{Message, TransactionConfig};

/// Identifies the version of a transaction message received over gRPC.
///
/// The wire's `versioned` boolean is true for **both** v0 and v1. The only
/// signal is the presence of `config` (field 7), which nothing but v1 sets.
pub fn message_version(message: &Message) -> MessageVersion {
    match (&message.config, message.versioned) {
        (Some(_), _) => MessageVersion::V1,
        (None, true) => MessageVersion::V0,
        (None, false) => MessageVersion::Legacy,
    }
}

/// Renders a v1 `TransactionConfig` as indented lines.
///
/// An absent field is not a default: an unset limit resolves to zero, not to
/// the generous v0-era defaults.
pub fn describe_config(config: &TransactionConfig, indent: &str) -> String {
    crate::ComputeBudget::from(config).describe(indent)
}
