//! Building, signing, and relaying the three layers of a programmatic signer action.
//!
//! ```text
//! relay transaction        signed by the hot relayer, fresh blockhash, pays the fee
//! └─ Submit instruction    to the Signer program
//!    └─ authorization message   signed by the cold authority, no blockhash, no expiry
//!       └─ Execute instruction  to the Executor program
//!          └─ execution message     fee payer and signer are the PDA, "blockhash" is the nonce
//!             └─ the action          an ordinary System transfer from the PDA
//! ```

use anyhow::{Context, Result};
use base64::prelude::{Engine, BASE64_STANDARD};
use serde::Serialize;
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_ed25519_signer_client::ProgrammaticSigner;

/// The address that acts for `authority`: a PDA of the Signer program.
///
/// Nothing is created on chain. It is a plain System-owned address that holds
/// SOL and owns token accounts like any wallet, and the Signer program promotes
/// it to a signer whenever `authority` has signed an authorization for it.
pub fn programmatic_signer(authority: &Address) -> Address {
    ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, authority)
}

/// The budget the relay transaction requests.
///
/// Unset v1 limits are zero, not the legacy defaults, so the relayer has to
/// state them. The Signer and Executor programs plus one promoted PDA cost
/// about 55,000 compute units for a SOL transfer; the limit leaves room for a
/// larger action without being the 1.4 million maximum the Anza CLI requests.
pub const RELAY_CONFIG: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(200_000)
    .with_loaded_accounts_data_size_limit(4 * 1024 * 1024);

/// Builds the execution message: the action, as the PDA would send it.
///
/// The PDA is the fee payer and signer, which it could never be in a real
/// transaction; the executor fills those roles by CPI. The blockhash slot holds
/// the nonce value instead of a blockhash, and the transaction config is empty
/// because the message is never executed at the top level.
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

/// Builds the authorization message that `authorities` sign.
///
/// It is a v1 message holding exactly one instruction, `Execute`, whose data
/// carries the execution message. Its required signers are the authorities, so
/// signing it with an ordinary ed25519 key is signing a Solana message, which
/// hardware wallets and custody systems can at least ingest. It has no
/// blockhash and no transaction config.
pub fn authorization_message(
    execution_message: &v1::Message,
    nonce_account: &Address,
    nonce_authority: &Address,
    authorities: &[Address],
) -> Result<v1::Message> {
    let execute = spl_message_executor_client::instruction::execute(
        nonce_account,
        nonce_authority,
        execution_message,
    );
    spl_ed25519_signer_client::message::authorization_message(&execute, authorities)
        .context("failed to build the authorization message")
}

/// Signs the authorization message with a cold key.
///
/// This is the only thing the cold key ever signs. It needs no RPC, no
/// blockhash, and no SOL.
pub fn sign_authorization(authorization_message: &v1::Message, authority: &Keypair) -> Signature {
    authority.sign_message(&authorization_message.serialize())
}

/// What crosses from the cold side to the hot side: everything the relayer
/// needs and nothing it can alter without invalidating the signature.
#[derive(Serialize)]
pub struct Artifact {
    /// The authorization message, base64, exactly as signed.
    pub authorization_message: String,
    /// One signature per authority, as `address=signature` pairs.
    pub signatures: Vec<String>,
    /// The nonce value the execution consumes.
    pub consumed_nonce: String,
    /// The nonce value the account will hold afterwards.
    pub next_nonce: String,
}

impl Artifact {
    pub fn new(
        authorization_message: &v1::Message,
        signatures: &[(Address, Signature)],
        consumed_nonce: Hash,
        next_nonce: Hash,
    ) -> Self {
        Self {
            authorization_message: BASE64_STANDARD.encode(authorization_message.serialize()),
            signatures: signatures
                .iter()
                .map(|(address, signature)| format!("{address}={signature}"))
                .collect(),
            consumed_nonce: consumed_nonce.to_string(),
            next_nonce: next_nonce.to_string(),
        }
    }
}

/// Builds the relay transaction: a normal v1 transaction from `relayer` holding
/// one `Submit` instruction, signed by the relayer alone.
///
/// The authorities' signatures travel inside the instruction data. The relayer
/// supplies the blockhash, pays the fee, and sets the compute budget; it cannot
/// change what the authorities approved.
pub fn relay_transaction(
    authorization_message: &v1::Message,
    signatures: Vec<Signature>,
    relayer: &Keypair,
    blockhash: Hash,
) -> Result<VersionedTransaction> {
    let submit = spl_ed25519_signer_client::instruction::submit(
        signatures.into_iter().map(Some).collect(),
        VersionedMessage::V1(authorization_message.clone()),
    );
    let message =
        v1::Message::try_compile_with_config(&relayer.pubkey(), &[submit], blockhash, RELAY_CONFIG)
            .context("failed to compile the relay transaction")?;
    Ok(VersionedTransaction::try_new(
        VersionedMessage::V1(message),
        &[relayer],
    )?)
}
