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
    let priority_fee = match config.priority_fee {
        Some(lamports) => format!("{lamports} lamports (total, not micro-lamports/CU)"),
        None => "unset (0)".to_string(),
    };
    [
        format!("{indent}priority_fee:                    {priority_fee}"),
        format!(
            "{indent}compute_unit_limit:              {}",
            optional_u32(config.compute_unit_limit, "0")
        ),
        format!(
            "{indent}loaded_accounts_data_size_limit: {}",
            optional_u32(config.loaded_accounts_data_size_limit, "0")
        ),
        format!(
            "{indent}heap_size:                       {}",
            optional_u32(config.heap_size, "32KB default")
        ),
    ]
    .join("\n")
}

fn optional_u32(value: Option<u32>, unset_meaning: &str) -> String {
    match value {
        Some(value) => value.to_string(),
        None => format!("unset ({unset_meaning})"),
    }
}
