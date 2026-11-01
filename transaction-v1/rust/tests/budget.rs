//! Offline tests for reading a compute budget across all three versions.

use solana_address::Address;
use solana_hash::Hash;
use solana_message::{legacy, v0, v1, Instruction, VersionedMessage};
use txv1::budget::{default_compute_unit_limit, ComputeBudget};
use txv1::send::EXAMPLE_CONFIG;
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

// The same accessor, for a message decoded off the wire rather than received
// over gRPC.

/// A ComputeBudget program instruction, as a client would compile it: one
/// discriminant byte, then the little-endian operand.
fn compute_budget_program_instruction(discriminant: u8, operand: &[u8]) -> Instruction {
    let mut data = vec![discriminant];
    data.extend_from_slice(operand);
    Instruction::new_with_bytes(solana_sdk_ids::compute_budget::ID, &data, Vec::new())
}

fn transfer(payer: &Address) -> Instruction {
    solana_system_interface::instruction::transfer(payer, &Address::new_unique(), 1)
}

fn legacy_message(payer: &Address, instructions: &[Instruction]) -> VersionedMessage {
    VersionedMessage::Legacy(legacy::Message::new_with_blockhash(
        instructions,
        Some(payer),
        &Hash::default(),
    ))
}

fn v0_message(payer: &Address, instructions: &[Instruction]) -> VersionedMessage {
    VersionedMessage::V0(
        v0::Message::try_compile(payer, instructions, &[], Hash::default())
            .expect("v0 message compiles"),
    )
}

#[test]
fn a_decoded_v1_budget_is_read_straight_off_the_config() {
    let payer = Address::new_unique();
    let message = v1::Message::try_compile_with_config(
        &payer,
        &[transfer(&payer)],
        Hash::default(),
        EXAMPLE_CONFIG,
    )
    .expect("v1 message compiles");

    assert_eq!(
        ComputeBudget::of_versioned_message(&VersionedMessage::V1(message)),
        ComputeBudget {
            compute_unit_limit: Some(20_000),
            heap_size: Some(65_536),
            loaded_accounts_data_size_limit: Some(65_536),
            priority_fee_lamports: Some(5_000),
        }
    );
}

#[test]
fn an_equivalent_budget_is_recovered_from_a_decoded_legacy_transaction() {
    // 20,000 CU at 250,000 micro-lamports/CU is the 5,000 lamports the v1
    // config states directly.
    let payer = Address::new_unique();
    let message = legacy_message(
        &payer,
        &[
            transfer(&payer),
            compute_budget_program_instruction(2, &20_000u32.to_le_bytes()),
            compute_budget_program_instruction(3, &250_000u64.to_le_bytes()),
        ],
    );

    assert_eq!(
        ComputeBudget::of_versioned_message(&message),
        ComputeBudget {
            compute_unit_limit: Some(20_000),
            priority_fee_lamports: Some(5_000),
            ..ComputeBudget::default()
        }
    );
}

#[test]
fn an_equivalent_budget_is_recovered_from_a_decoded_v0_transaction() {
    let payer = Address::new_unique();
    let message = v0_message(
        &payer,
        &[
            transfer(&payer),
            compute_budget_program_instruction(2, &20_000u32.to_le_bytes()),
            compute_budget_program_instruction(3, &250_000u64.to_le_bytes()),
        ],
    );

    assert_eq!(
        ComputeBudget::of_versioned_message(&message),
        ComputeBudget {
            compute_unit_limit: Some(20_000),
            priority_fee_lamports: Some(5_000),
            ..ComputeBudget::default()
        }
    );
}

#[test]
fn a_decoded_transaction_that_states_no_budget_reports_nothing_set() {
    let payer = Address::new_unique();
    assert_eq!(
        ComputeBudget::of_versioned_message(&v0_message(&payer, &[transfer(&payer)])),
        ComputeBudget::default()
    );
}

#[test]
fn a_decoded_price_without_a_limit_charges_the_implicit_limit() {
    // Two instructions: the transfer and the price itself.
    let payer = Address::new_unique();
    let message = legacy_message(
        &payer,
        &[
            transfer(&payer),
            compute_budget_program_instruction(3, &1_000_000u64.to_le_bytes()),
        ],
    );

    assert_eq!(
        ComputeBudget::of_versioned_message(&message).priority_fee_lamports,
        Some(u64::from(default_compute_unit_limit(2)))
    );
}

#[test]
fn a_budget_describes_what_each_absent_field_resolves_to() {
    let described = ComputeBudget {
        compute_unit_limit: Some(20_000),
        ..ComputeBudget::default()
    }
    .describe("");

    assert_eq!(
        described.lines().collect::<Vec<_>>(),
        [
            "priority_fee:                    unset (0)",
            "compute_unit_limit:              20000",
            "loaded_accounts_data_size_limit: unset (0)",
            "heap_size:                       unset (32KB default)",
        ]
    );
}
