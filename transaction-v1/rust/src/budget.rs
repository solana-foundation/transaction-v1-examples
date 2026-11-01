//! Reading a transaction's compute budget regardless of its version.
//!
//! Legacy and v0 state their budget in ComputeBudget program instructions, v1
//! in the message config. [`ComputeBudget::of_message`] reads both from a
//! message that arrived over gRPC, and [`ComputeBudget::of_versioned_message`]
//! from a transaction decoded off the wire — what an RPC response, a
//! facilitator request body, or a wallet's `signTransaction` output carries.

use crate::MessageVersion;
use solana_message::{v1, VersionedMessage};
use yellowstone_grpc_proto::solana::storage::confirmed_block::{Message, TransactionConfig};

/// The default compute unit limit applied to each instruction when a legacy or
/// v0 transaction does not set one.
pub const DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION: u32 = 200_000;

/// The ceiling a legacy or v0 transaction's implicit compute unit limit is
/// clamped to, and the most any transaction can request.
pub const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;

/// The most loaded account data a transaction can request, in bytes.
///
/// Agave's `MAX_LOADED_ACCOUNTS_DATA_SIZE_BYTES`, in `execution_budget.rs`.
pub const MAX_LOADED_ACCOUNTS_DATA_SIZE_LIMIT: u32 = 64 * 1024 * 1024;

/// A transaction's compute budget, normalised across all three versions.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ComputeBudget {
    pub compute_unit_limit: Option<u32>,
    pub heap_size: Option<u32>,
    pub loaded_accounts_data_size_limit: Option<u32>,
    /// The total priority fee in lamports.
    ///
    /// v1 states this directly; legacy and v0 state a price in micro-lamports
    /// per compute unit — see [`ComputeBudget::of_message`].
    pub priority_fee_lamports: Option<u64>,
}

impl ComputeBudget {
    /// Reads the compute budget out of a message received over gRPC.
    ///
    /// v1 reads `config` directly; legacy and v0 scan ComputeBudget program
    /// instructions and convert the fee to a total in lamports so the two are
    /// comparable.
    pub fn of_message(message: &Message) -> Self {
        match crate::grpc::message_version(message) {
            MessageVersion::V1 => message.config.as_ref().map(Self::from).unwrap_or_default(),
            MessageVersion::Legacy | MessageVersion::V0 => {
                // gRPC delivers account keys as raw protobuf `bytes`.
                let compute_budget_data = message
                    .instructions
                    .iter()
                    .filter(|instruction| {
                        message
                            .account_keys
                            .get(instruction.program_id_index as usize)
                            .map(Vec::as_slice)
                            == Some(solana_sdk_ids::compute_budget::ID.as_array())
                    })
                    .map(|instruction| instruction.data.as_slice());
                Self::from_instruction_data(compute_budget_data, message.instructions.len())
            }
        }
    }

    /// Reads the compute budget out of a transaction message decoded off the
    /// wire.
    ///
    /// The same normalisation as [`ComputeBudget::of_message`], for a message
    /// that came back from `getTransaction` or arrived as base64 rather than
    /// over gRPC. Decoding needs no account lookups, because v1 cannot use
    /// address lookup tables and the legacy and v0 budget instructions only
    /// ever name static keys.
    pub fn of_versioned_message(message: &VersionedMessage) -> Self {
        match message {
            VersionedMessage::V1(message) => Self::from(&message.config),
            VersionedMessage::Legacy(_) | VersionedMessage::V0(_) => {
                let account_keys = message.static_account_keys();
                let instructions = message.instructions();
                let compute_budget_data = instructions
                    .iter()
                    .filter(|instruction| {
                        account_keys.get(usize::from(instruction.program_id_index))
                            == Some(&solana_sdk_ids::compute_budget::ID)
                    })
                    .map(|instruction| instruction.data.as_slice());
                Self::from_instruction_data(compute_budget_data, instructions.len())
            }
        }
    }

    /// Builds a budget out of the data of every ComputeBudget instruction in a
    /// legacy or v0 transaction.
    ///
    /// `instruction_count` is how many instructions the transaction holds in
    /// total, ComputeBudget ones included, which sets the implicit compute unit
    /// limit when the transaction prices units without limiting them.
    fn from_instruction_data<'a>(
        compute_budget_data: impl Iterator<Item = &'a [u8]>,
        instruction_count: usize,
    ) -> Self {
        let mut budget = Self::default();
        let mut price_micro_lamports_per_cu = None;

        for data in compute_budget_data {
            let Some((discriminant, operand)) = data.split_first() else {
                continue;
            };
            match discriminant {
                1 => budget.heap_size = read_u32(operand),
                2 => budget.compute_unit_limit = read_u32(operand),
                3 => price_micro_lamports_per_cu = read_u64(operand),
                4 => budget.loaded_accounts_data_size_limit = read_u32(operand),
                _ => {}
            }
        }

        budget.priority_fee_lamports = price_micro_lamports_per_cu.map(|price| {
            let limit = budget
                .compute_unit_limit
                .unwrap_or_else(|| default_compute_unit_limit(instruction_count));
            // The runtime rounds the total up to whole lamports.
            u64::from(limit).saturating_mul(price).div_ceil(1_000_000)
        });

        budget
    }

    /// Renders the budget as indented lines, spelling out what each absent
    /// field means.
    ///
    /// The annotations describe v1's rules: an absent limit resolves to zero,
    /// and only `heap_size` falls back to 32 KB. On legacy and v0 an absent
    /// compute unit limit resolves to [`default_compute_unit_limit`] instead.
    pub fn describe(&self, indent: &str) -> String {
        let priority_fee = match self.priority_fee_lamports {
            Some(lamports) => format!("{lamports} lamports (total, not micro-lamports/CU)"),
            None => "unset (0)".to_string(),
        };
        [
            format!("{indent}priority_fee:                    {priority_fee}"),
            format!(
                "{indent}compute_unit_limit:              {}",
                optional_u32(self.compute_unit_limit, "0")
            ),
            format!(
                "{indent}loaded_accounts_data_size_limit: {}",
                optional_u32(self.loaded_accounts_data_size_limit, "0")
            ),
            format!(
                "{indent}heap_size:                       {}",
                optional_u32(self.heap_size, "32KB default")
            ),
        ]
        .join("\n")
    }
}

/// A v1 config is already the normalised shape; only the field names differ.
impl From<&v1::TransactionConfig> for ComputeBudget {
    fn from(config: &v1::TransactionConfig) -> Self {
        Self {
            compute_unit_limit: config.compute_unit_limit,
            heap_size: config.heap_size,
            loaded_accounts_data_size_limit: config.loaded_accounts_data_size_limit,
            priority_fee_lamports: config.priority_fee,
        }
    }
}

/// The same config as the gRPC wire delivers it.
impl From<&TransactionConfig> for ComputeBudget {
    fn from(config: &TransactionConfig) -> Self {
        Self {
            compute_unit_limit: config.compute_unit_limit,
            heap_size: config.heap_size,
            loaded_accounts_data_size_limit: config.loaded_accounts_data_size_limit,
            priority_fee_lamports: config.priority_fee,
        }
    }
}

/// The compute unit limit a legacy or v0 transaction gets when it sets none.
pub fn default_compute_unit_limit(instruction_count: usize) -> u32 {
    let requested = DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION
        .saturating_mul(u32::try_from(instruction_count).unwrap_or(u32::MAX));
    requested.min(MAX_COMPUTE_UNIT_LIMIT)
}

fn optional_u32(value: Option<u32>, unset_meaning: &str) -> String {
    match value {
        Some(value) => value.to_string(),
        None => format!("unset ({unset_meaning})"),
    }
}

fn read_u32(operand: &[u8]) -> Option<u32> {
    operand.get(..4)?.try_into().ok().map(u32::from_le_bytes)
}

fn read_u64(operand: &[u8]) -> Option<u64> {
    operand.get(..8)?.try_into().ok().map(u64::from_le_bytes)
}
