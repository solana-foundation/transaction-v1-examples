//! Reading a transaction's compute budget regardless of its version.
//!
//! Legacy and v0 state their budget in ComputeBudget program instructions, v1
//! in the message config. [`ComputeBudget::of_message`] reads both.

use crate::MessageVersion;
use yellowstone_grpc_proto::solana::storage::confirmed_block::Message;

/// The default compute unit limit applied to each instruction when a legacy or
/// v0 transaction does not set one.
pub const DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION: u32 = 200_000;

/// The ceiling a legacy or v0 transaction's implicit compute unit limit is
/// clamped to.
pub const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;

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
            MessageVersion::V1 => Self::from_config(message),
            MessageVersion::Legacy | MessageVersion::V0 => Self::from_instructions(message),
        }
    }

    fn from_config(message: &Message) -> Self {
        let Some(config) = &message.config else {
            return Self::default();
        };
        Self {
            compute_unit_limit: config.compute_unit_limit,
            heap_size: config.heap_size,
            loaded_accounts_data_size_limit: config.loaded_accounts_data_size_limit,
            priority_fee_lamports: config.priority_fee,
        }
    }

    fn from_instructions(message: &Message) -> Self {
        let mut budget = Self::default();
        let mut price_micro_lamports_per_cu = None;

        for instruction in &message.instructions {
            let program_id = message
                .account_keys
                .get(instruction.program_id_index as usize);
            if program_id.map(Vec::as_slice) != Some(solana_sdk_ids::compute_budget::ID.as_array())
            {
                continue;
            }
            let Some((discriminant, operand)) = instruction.data.split_first() else {
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
                .unwrap_or_else(|| default_compute_unit_limit(message.instructions.len()));
            // The runtime rounds the total up to whole lamports.
            u64::from(limit).saturating_mul(price).div_ceil(1_000_000)
        });

        budget
    }
}

/// The compute unit limit a legacy or v0 transaction gets when it sets none.
pub fn default_compute_unit_limit(instruction_count: usize) -> u32 {
    let requested = DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION
        .saturating_mul(u32::try_from(instruction_count).unwrap_or(u32::MAX));
    requested.min(MAX_COMPUTE_UNIT_LIMIT)
}

fn read_u32(operand: &[u8]) -> Option<u32> {
    operand.get(..4)?.try_into().ok().map(u32::from_le_bytes)
}

fn read_u64(operand: &[u8]) -> Option<u64> {
    operand.get(..8)?.try_into().ok().map(u64::from_le_bytes)
}
