//! Reads the compute budget out of a base64 transaction, whatever its version.
//!
//! The three versions state the same budget in two different places, in two
//! different units, so a consumer that only knows one of them reports the
//! others wrong rather than failing: a pipeline that scans ComputeBudget
//! instructions sees no budget at all on v1, and one that reads `config` sees
//! none on legacy or v0. [`ComputeBudget::of_versioned_message`] switches on
//! the decoded version and normalises both into v1's four fields.
//!
//! With no argument this builds one transaction per version, each carrying the
//! same budget, and prints what comes back out. Pass a base64 transaction to
//! read that one instead:
//!
//!     just decode-budget "$(solana -u m confirm -v <signature> …)"
//!
//! Run with `just decode-budget`. Needs no validator.

use anyhow::{Context, Result};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use clap::Parser;
use solana_address::{address, Address};
use solana_hash::Hash;
use solana_message::{legacy, v0, v1, Instruction, VersionedMessage};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_status_client_types::{EncodedTransaction, TransactionBinaryEncoding};
use txv1::send::EXAMPLE_CONFIG;
use txv1::{ComputeBudget, MessageVersion};

#[derive(Parser)]
#[command(about = "Read the compute budget out of a base64 transaction of any version")]
struct Args {
    /// A signed transaction as base64. Without one, a legacy, a v0, and a v1
    /// transaction carrying the same budget are built and read instead.
    base64: Option<String>,
}

const FEE_PAYER: Address = address!("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const RECIPIENT: Address = address!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

/// Nothing here is sent, so any blockhash serializes.
const LIFETIME: Hash = Hash::new_from_array([0; 32]);

// `EXAMPLE_CONFIG` sets every field, so these unwraps are checked when the
// constants are evaluated at compile time.
const COMPUTE_UNIT_LIMIT: u32 = EXAMPLE_CONFIG.compute_unit_limit.unwrap();
const LOADED_ACCOUNTS_DATA_SIZE_LIMIT: u32 =
    EXAMPLE_CONFIG.loaded_accounts_data_size_limit.unwrap();
const HEAP_SIZE: u32 = EXAMPLE_CONFIG.heap_size.unwrap();
const PRIORITY_FEE_LAMPORTS: u64 = EXAMPLE_CONFIG.priority_fee.unwrap();

/// The per-compute-unit price that costs the same as [`EXAMPLE_CONFIG`]'s
/// total, at that config's compute unit limit.
///
/// 20,000 CU × 250,000 micro-lamports/CU = 5,000 lamports.
const EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU: u64 =
    PRIORITY_FEE_LAMPORTS * 1_000_000 / COMPUTE_UNIT_LIMIT as u64;

fn main() -> Result<()> {
    let args = Args::parse();

    match args.base64.filter(|base64| !base64.trim().is_empty()) {
        Some(base64) => report("from the argument", base64.trim()),
        None => {
            println!(
                "The same budget three ways: a priority fee of \
                 {EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU} micro-lamports/CU on"
            );
            println!(
                "legacy and v0, and {PRIORITY_FEE_LAMPORTS} lamports on v1 — the same cost at \
                 {COMPUTE_UNIT_LIMIT} CU."
            );

            report("legacy", &legacy_transaction()?)?;
            report("v0", &v0_transaction()?)?;
            report("v1", &v1_transaction()?)
        }
    }
}

fn transfer() -> Instruction {
    solana_system_interface::instruction::transfer(&FEE_PAYER, &RECIPIENT, 1)
}

/// One ComputeBudget program instruction.
///
/// The program's instruction data is a Borsh enum: one discriminant byte, then
/// the little-endian operand — the layout `txv1::budget` reads back.
fn compute_budget_instruction(discriminant: u8, operand: &[u8]) -> Instruction {
    let mut data = vec![discriminant];
    data.extend_from_slice(operand);
    Instruction::new_with_bytes(solana_sdk_ids::compute_budget::ID, &data, Vec::new())
}

/// The transfer plus the four ComputeBudget instructions that state
/// [`EXAMPLE_CONFIG`]'s budget on legacy and v0.
///
/// Each one costs an instruction, and together they add the program's account
/// key, so the budget takes message space the v1 config does not.
fn transfer_with_compute_budget_instructions() -> [Instruction; 5] {
    [
        transfer(),
        // SetComputeUnitLimit
        compute_budget_instruction(2, &COMPUTE_UNIT_LIMIT.to_le_bytes()),
        // SetComputeUnitPrice
        compute_budget_instruction(3, &EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU.to_le_bytes()),
        // SetLoadedAccountsDataSizeLimit
        compute_budget_instruction(4, &LOADED_ACCOUNTS_DATA_SIZE_LIMIT.to_le_bytes()),
        // RequestHeapFrame
        compute_budget_instruction(1, &HEAP_SIZE.to_le_bytes()),
    ]
}

fn legacy_transaction() -> Result<String> {
    let message = legacy::Message::new_with_blockhash(
        &transfer_with_compute_budget_instructions(),
        Some(&FEE_PAYER),
        &LIFETIME,
    );
    to_base64(VersionedMessage::Legacy(message))
}

fn v0_transaction() -> Result<String> {
    let message = v0::Message::try_compile(
        &FEE_PAYER,
        &transfer_with_compute_budget_instructions(),
        &[],
        LIFETIME,
    )?;
    to_base64(VersionedMessage::V0(message))
}

fn v1_transaction() -> Result<String> {
    // The whole budget is one field on the message, so the instruction list
    // holds only the transfer.
    let message =
        v1::Message::try_compile_with_config(&FEE_PAYER, &[transfer()], LIFETIME, EXAMPLE_CONFIG)?;
    to_base64(VersionedMessage::V1(message))
}

/// Serializes a message the way a client hands one to a server: wrapped in a
/// transaction, then base64.
///
/// The signature slots hold zeros, since nothing here is sent and the budget
/// is read off the message alone. `wincode` is the SDK's wire codec; a v1
/// message serialized through serde comes out in a different layout that no
/// decoder accepts as a transaction.
fn to_base64(message: VersionedMessage) -> Result<String> {
    let transaction = VersionedTransaction {
        signatures: vec![
            Signature::default();
            usize::from(message.header().num_required_signatures)
        ],
        message,
    };
    Ok(BASE64_STANDARD.encode(wincode::serialize(&transaction)?))
}

fn report(label: &str, base64: &str) -> Result<()> {
    // The same decoder `getTransaction` responses go through: it reads the
    // version prefix, so the caller never has to know the version up front.
    let transaction =
        EncodedTransaction::Binary(base64.to_string(), TransactionBinaryEncoding::Base64)
            .decode()
            .context("the argument is not a base64-encoded transaction")?;

    println!("\n== {label} ==");
    println!("  version: {}", MessageVersion::from(&transaction.message));
    println!(
        "{}",
        ComputeBudget::of_versioned_message(&transaction.message).describe("  ")
    );
    Ok(())
}
