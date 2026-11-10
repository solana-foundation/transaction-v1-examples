//! Signs a SOL transfer with a cold key that never goes online, then relays it
//! after the blockhash that was current at signing time has expired.
//!
//! The same transfer is sent twice. First as a System durable nonce
//! transaction, the flow being replaced. Then as a programmatic signer
//! authorization: the cold key signs an authorization message, a hot relayer
//! wraps it in a transaction with a fresh blockhash, and the PDA that acts for
//! the cold key pays. Afterwards the nonce has advanced to the value predicted
//! at signing time, and relaying the same artifact again is rejected.
//!
//! Run with `just sign-relay`.

use anyhow::{bail, Result};
use clap::Parser;
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
    wait_for_blockhash_expiry,
};
use psigner::durable_nonce::{
    create_durable_nonce_account, fetch_durable_nonce, sign_durable_nonce_transfer,
};
use psigner::signer::{
    authorization_message, execution_message, programmatic_signer_address, relay_transaction,
    sign_authorization, Artifact,
};
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::DEFAULT_RPC_URL;
use solana_commitment_config::CommitmentConfig;
use solana_keypair::Keypair;
use solana_message::VersionedMessage;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;

const AMOUNT: u64 = 10_000_000;

#[derive(Parser)]
#[command(about = "Sign a transfer offline with a cold key and relay it later")]
struct Args {
    #[arg(long, env = "PSIGNER_RPC_URL", default_value = DEFAULT_RPC_URL)]
    rpc_url: String,
    /// Relay immediately instead of waiting for the signing-time blockhash to expire.
    #[arg(long, env = "PSIGNER_SKIP_EXPIRY")]
    skip_expiry: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let client = client(&args.rpc_url);
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 2_000_000_000)?;
    let recipient = Keypair::new().pubkey();

    // The flow being replaced. The cold key holds the funds and pays the fee,
    // so it has to be funded, and it signs a whole transaction.
    println!("== before: a System durable nonce transaction ==");
    let cold = funded_keypair(&client, 1_000_000_000)?;
    let durable_nonce_account = create_durable_nonce_account(&client, &cold)?;
    let durable_nonce = fetch_durable_nonce(&client, &durable_nonce_account)?;
    let durable = sign_durable_nonce_transfer(
        &cold,
        &durable_nonce_account,
        durable_nonce,
        &recipient,
        AMOUNT,
    )?;
    println!("  nonce account: {durable_nonce_account}");
    println!("  nonce:         {durable_nonce}");
    println!(
        "  signed by:     {} (the cold key, which also pays)",
        cold.pubkey()
    );
    println!("  size:          {} bytes", versioned_size(&durable));
    let signature = client.send_and_confirm_transaction(&durable)?;
    println!("  landed:        {signature}");
    let advanced = fetch_durable_nonce(&client, &durable_nonce_account)?;
    println!("  nonce after:   {advanced} (a future blockhash; not knowable at signing time)");

    // The replacement. The cold key is never funded and never signs a
    // transaction. A PDA derived from it holds the funds instead.
    println!("\n== after: a programmatic signer authorization ==");
    let authority = Keypair::new();
    let pda = programmatic_signer_address(&authority.pubkey());
    println!(
        "  authority: {} (cold; holds nothing, signs one message)",
        authority.pubkey()
    );
    println!("  pda:       {pda} (holds the funds; nothing to create)");

    // Fund the PDA. It is a plain System-owned address, so this is an ordinary
    // transfer; in a migration it is where the cold key's SOL moves to.
    send_transaction(
        &client,
        &relayer,
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &pda,
            1_000_000_000,
        )],
        &[&relayer],
    )?;

    // One SPL nonce account per action in flight. The relayer pays the rent;
    // the PDA is the authority, so only an authorization can consume it.
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {nonce}");

    // The cold side. Nothing below needs an RPC: the execution message, the
    // authorization message, and the signature can all be produced air-gapped
    // once the nonce value is known.
    println!("\n== signed on the cold side ==");
    let transfer = system_instruction::transfer(&pda, &recipient, AMOUNT);
    let execution = execution_message(&pda, &[transfer], nonce)?;
    let authorization =
        authorization_message(&execution, &nonce_account, &pda, &[authority.pubkey()])?;
    let signature = sign_authorization(&authorization, &authority);
    let predicted = next_nonce(&nonce_account, &execution);
    let artifact = Artifact::new(
        &authorization,
        &[(authority.pubkey(), signature)],
        nonce,
        predicted,
    );
    println!(
        "  execution message:     {} bytes, {} instruction (the transfer)",
        execution.serialize().len(),
        execution.instructions.len()
    );
    println!(
        "  authorization message: {} bytes, {} instruction (Execute, wrapping it)",
        authorization.serialize().len(),
        authorization.instructions.len()
    );
    println!(
        "  signers:               {:?}",
        &authorization.account_keys[..usize::from(authorization.header.num_required_signatures)]
    );
    println!(
        "  artifact:              {}",
        serde_json::to_string_pretty(&artifact)?.replace('\n', "\n                         ")
    );

    // A transaction signed now would die with this blockhash. The artifact has
    // no blockhash, so it does not.
    let blockhash_at_signing = client.get_latest_blockhash()?;
    if args.skip_expiry {
        println!("\n== skipping the wait for blockhash {blockhash_at_signing} to expire ==");
    } else {
        println!("\n== waiting for blockhash {blockhash_at_signing} to expire (about a minute) ==");
        wait_for_blockhash_expiry(&client, &blockhash_at_signing)?;
        if client.is_blockhash_valid(&blockhash_at_signing, CommitmentConfig::confirmed())? {
            bail!("the blockhash is still valid");
        }
        println!("  expired; a transaction signed alongside the artifact would now be dropped");
    }

    // The hot side. Any funded key can relay; it learns nothing it can change.
    println!("\n== relayed ==");
    let relay = relay_transaction(
        &authorization,
        vec![signature],
        &relayer,
        client.get_latest_blockhash()?,
    )?;
    let relay_signers = &relay.message.static_account_keys()[..relay.signatures.len()];
    if relay_signers.contains(&authority.pubkey()) {
        bail!("the authority must not sign the relay transaction");
    }
    println!(
        "  relay transaction: {} bytes, v1, signed by {relay_signers:?} (the relayer)",
        versioned_size(&relay)
    );
    let relay_signature = client.send_and_confirm_transaction(&relay)?;
    println!("  landed:            {relay_signature}");
    if let Some(units) = compute_units(&client, &relay_signature)? {
        println!("  compute units:     {units}");
    }

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports (both transfers)");
    if balance != 2 * AMOUNT {
        bail!("expected the recipient to hold {} lamports", 2 * AMOUNT);
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  predicted:         {predicted}");
    if advanced != predicted {
        bail!("the nonce did not advance to the value predicted at signing time");
    }

    // The nonce value the artifact names is gone, so the executor refuses it.
    // Error 3 is the Executor's NonceMismatch, surfaced through the Signer.
    println!("\n== relayed again ==");
    let replay = relay_transaction(
        &authorization,
        vec![signature],
        &relayer,
        client.get_latest_blockhash()?,
    )?;
    match client.send_and_confirm_transaction(&replay) {
        Ok(signature) => bail!("the replay unexpectedly landed as {signature}"),
        Err(error) => {
            let text = error.to_string();
            // The RPC appends the program logs; the first line names the error.
            println!("  rejected: {}", text.lines().next().unwrap_or_default());
            if !text.contains("custom program error: 0x3") {
                bail!("expected the executor's NonceMismatch (custom program error 0x3)");
            }
        }
    }
    Ok(())
}

/// The wire size of a v1 transaction: the message, then one signature per
/// required signer, with no count in front.
fn versioned_size(transaction: &VersionedTransaction) -> usize {
    let VersionedMessage::V1(message) = &transaction.message else {
        unreachable!("every transaction here is v1");
    };
    message.serialize().len() + transaction.signatures.len() * 64
}
