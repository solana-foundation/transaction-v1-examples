//! Signs a token withdrawal with a cold key that never goes online, then
//! relays it from a hot key: the PDA moves 250 of a Token program mint, the
//! kind USDC is, to a recipient whose token account does not exist yet and
//! creates that account on the way.
//!
//! Run with `just token-transfer`.

use anyhow::{bail, Result};
use clap::Parser;
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::token::{create_mint, fetch_balance, mint_to_ata, transfer_to_ata, ui_amount};
use psigner::DEFAULT_RPC_URL;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;

/// 1,000 tokens at six decimals: what the PDA holds.
const SUPPLY: u64 = 1_000_000_000;
/// 250 tokens: what the withdrawal moves.
const AMOUNT: u64 = 250_000_000;

#[derive(Parser)]
#[command(about = "Sign a token withdrawal offline with a cold key and relay it later")]
struct Args {
    #[arg(long, env = "PSIGNER_RPC_URL", default_value = DEFAULT_RPC_URL)]
    rpc_url: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let client = client(&args.rpc_url);
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let authority = Keypair::new();
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    let recipient = Keypair::new().pubkey();

    println!("== setup: the PDA holds 1,000 tokens ==");
    println!("  authority: {} (cold)", authority.pubkey());
    println!("  pda:       {pda} (owns the token account)");
    // The PDA pays the rent of the token account it creates for the recipient,
    // so it needs some SOL as well as tokens.
    send_transaction(
        &client,
        &relayer,
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &pda,
            100_000_000,
        )],
        &[&relayer],
    )?;
    let mint = create_mint(&client, &relayer)?;
    let pda_account = mint_to_ata(&client, &relayer, &mint, &pda, SUPPLY)?;
    println!("  mint:        {mint}");
    println!(
        "  PDA account: {pda_account} holds {}",
        ui_amount(fetch_balance(&client, &pda_account)?)
    );
    println!("  recipient:   {recipient} (no token account yet; the PDA creates it)");
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {nonce}");

    // The cold side: two ordinary token instructions with the PDA as payer and
    // owner, compiled into an execution message, wrapped in an Execute
    // instruction, and signed. Nothing here needs an RPC.
    println!("\n== signed on the cold side ==");
    let execution = execution_message(
        &pda,
        &transfer_to_ata(&mint, &pda, &recipient, AMOUNT)?,
        nonce,
    )?;
    let submit = sign_and_submit(&execute(&nonce_account, &pda, &execution), &[&authority])?;
    let predicted = next_nonce(&nonce_account, &execution);
    println!(
        "  execution message:  {} bytes, 2 instructions (CreateAssociatedTokenAccountIdempotent, TransferChecked)",
        execution.serialize().len()
    );
    println!("  Submit instruction: {} bytes of data", submit.data.len());

    println!("\n== relayed ==");
    let landed = send_transaction(&client, &relayer, &[submit], &[&relayer])?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    println!("\n== read back ==");
    let recipient_account = get_associated_token_address(&recipient, &mint);
    let received = fetch_balance(&client, &recipient_account)?;
    println!(
        "  recipient account: {recipient_account} holds {} (created by the PDA, which paid its rent)",
        ui_amount(received)
    );
    if received != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT}");
    }
    let left = fetch_balance(&client, &pda_account)?;
    println!("  PDA account:       holds {}", ui_amount(left));
    if left != SUPPLY - AMOUNT {
        bail!("expected the PDA to hold {}", SUPPLY - AMOUNT);
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  predicted:         {predicted}");
    if advanced != predicted {
        bail!("the nonce did not advance to the value predicted at signing time");
    }
    Ok(())
}
