//! Offline tests for reading a compute budget across all three versions.

use txv1::budget::{default_compute_unit_limit, ComputeBudget};
use yellowstone_grpc_proto::solana::storage::confirmed_block::{
    CompiledInstruction, Message, TransactionConfig,
};

fn compute_budget_instruction(discriminant: u8, operand: &[u8]) -> CompiledInstruction {
    let mut data = vec![discriminant];
    data.extend_from_slice(operand);
    CompiledInstruction {
        program_id_index: 0,
        accounts: Vec::new(),
        data,
    }
}

/// A legacy or v0 message whose only account key is the ComputeBudget program.
fn instruction_message(instructions: Vec<CompiledInstruction>, versioned: bool) -> Message {
    Message {
        account_keys: vec![solana_sdk_ids::compute_budget::ID.to_bytes().to_vec()],
        config: None,
        instructions,
        versioned,
        ..Default::default()
    }
}

#[test]
fn a_v1_budget_is_read_straight_off_the_config() {
    let message = Message {
        config: Some(TransactionConfig {
            compute_unit_limit: Some(20_000),
            heap_size: Some(65_536),
            loaded_accounts_data_size_limit: Some(65_536),
            priority_fee: Some(5_000),
        }),
        versioned: true,
        ..Default::default()
    };

    let budget = ComputeBudget::of_message(&message);

    assert_eq!(budget.compute_unit_limit, Some(20_000));
    assert_eq!(budget.heap_size, Some(65_536));
    assert_eq!(budget.loaded_accounts_data_size_limit, Some(65_536));
    assert_eq!(budget.priority_fee_lamports, Some(5_000));
}

#[test]
fn a_v0_budget_is_recovered_from_compute_budget_instructions() {
    let message = instruction_message(
        vec![
            compute_budget_instruction(2, &20_000u32.to_le_bytes()),
            compute_budget_instruction(4, &65_536u32.to_le_bytes()),
            compute_budget_instruction(1, &65_536u32.to_le_bytes()),
        ],
        true,
    );

    let budget = ComputeBudget::of_message(&message);

    assert_eq!(budget.compute_unit_limit, Some(20_000));
    assert_eq!(budget.loaded_accounts_data_size_limit, Some(65_536));
    assert_eq!(budget.heap_size, Some(65_536));
}

#[test]
fn a_v0_priority_fee_is_converted_from_micro_lamports_per_unit_to_a_total() {
    // 20,000 CU at 250,000 micro-lamports/CU = 5,000,000,000 micro-lamports,
    // which is the 5,000 lamports a v1 transaction would state directly.
    let message = instruction_message(
        vec![
            compute_budget_instruction(2, &20_000u32.to_le_bytes()),
            compute_budget_instruction(3, &250_000u64.to_le_bytes()),
        ],
        true,
    );

    assert_eq!(
        ComputeBudget::of_message(&message).priority_fee_lamports,
        Some(5_000)
    );
}

#[test]
fn a_v0_priority_fee_rounds_up_to_whole_lamports() {
    // 1 CU at 1 micro-lamport is a millionth of a lamport, which the runtime
    // charges as one lamport rather than as zero.
    let message = instruction_message(
        vec![
            compute_budget_instruction(2, &1u32.to_le_bytes()),
            compute_budget_instruction(3, &1u64.to_le_bytes()),
        ],
        true,
    );

    assert_eq!(
        ComputeBudget::of_message(&message).priority_fee_lamports,
        Some(1)
    );
}

#[test]
fn a_v0_price_without_an_explicit_limit_uses_the_implicit_default() {
    let message = instruction_message(
        vec![compute_budget_instruction(3, &1_000_000u64.to_le_bytes())],
        true,
    );

    // One instruction, no SetComputeUnitLimit, so the limit is the 200k default
    // and a price of one lamport per CU totals 200,000 lamports.
    assert_eq!(default_compute_unit_limit(1), 200_000);
    assert_eq!(
        ComputeBudget::of_message(&message).priority_fee_lamports,
        Some(200_000)
    );
}

#[test]
fn the_implicit_limit_is_clamped_to_the_maximum() {
    assert_eq!(default_compute_unit_limit(7), 1_400_000);
    assert_eq!(default_compute_unit_limit(100), 1_400_000);
}

#[test]
fn a_transaction_with_no_budget_instructions_reports_nothing_set() {
    assert_eq!(
        ComputeBudget::of_message(&instruction_message(Vec::new(), false)),
        ComputeBudget::default()
    );
}

#[test]
fn instructions_from_other_programs_are_ignored() {
    let mut message = instruction_message(
        vec![compute_budget_instruction(2, &20_000u32.to_le_bytes())],
        true,
    );
    // Point the instruction at a different program without changing its data.
    message.account_keys[0] = vec![7u8; 32];

    assert_eq!(
        ComputeBudget::of_message(&message).compute_unit_limit,
        None,
        "only the ComputeBudget program's instructions carry a budget"
    );
}

#[test]
fn a_v1_message_never_falls_back_to_scanning_instructions() {
    // A v1 message carrying a ComputeBudget instruction is malformed, but the
    // config is still the only authority: silently preferring the instruction
    // is exactly the mix-up this accessor exists to prevent.
    let mut message = instruction_message(
        vec![compute_budget_instruction(2, &999_999u32.to_le_bytes())],
        true,
    );
    message.config = Some(TransactionConfig {
        compute_unit_limit: Some(20_000),
        ..Default::default()
    });

    assert_eq!(
        ComputeBudget::of_message(&message).compute_unit_limit,
        Some(20_000)
    );
}
