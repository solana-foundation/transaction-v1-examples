//! The layers of a programmatic signer action.
//!
//! ```text
//! relay transaction        signed by the hot relayer, fresh blockhash, pays the fee
//! └─ Submit instruction    to the Signer program
//!    └─ authorization message   signed by the cold authority, no blockhash, no expiry
//!       └─ Execute instruction  to the Executor program
//!          └─ execution message     fee payer and signer are the PDA, "blockhash" is the nonce
//!             └─ the action          an ordinary System transfer from the PDA
//! ```
//!
//! The Anza client crates build every layer but the innermost:
//! `spl_message_executor_client::instruction::execute` wraps the execution
//! message, `spl_ed25519_signer_client::signing::sign_and_submit` builds the
//! authorization message, signs it with the cold key, and returns the `Submit`
//! instruction, and the relayer sends that instruction like any other.

use anyhow::{Context, Result};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_message::v1;

/// Builds the execution message: the action, as the PDA would send it.
///
/// The PDA is the fee payer and signer, which it could never be in a real
/// transaction; the executor fills those roles by CPI. The blockhash slot holds
/// the nonce value instead of a blockhash, and the transaction config is empty
/// because the message never runs as a transaction of its own.
pub fn execution_message(
    pda: &Address,
    instructions: &[Instruction],
    nonce: Hash,
) -> Result<v1::Message> {
    let message = v1::Message::try_compile_with_config(
        pda,
        instructions,
        nonce,
        v1::TransactionConfig::empty(),
    )
    .context("failed to compile the execution message")?;
    message
        .validate()
        .context("the execution message is not a valid v1 message")?;
    Ok(message)
}
