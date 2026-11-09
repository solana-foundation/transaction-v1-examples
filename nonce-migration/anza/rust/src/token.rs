//! Token accounts for the examples: a mint, balances, and the instructions a
//! PDA uses to move tokens.
//!
//! The PDA owns token accounts the way any wallet does. Its associated token
//! account is derived from its address, tokens arrive there by an ordinary
//! `MintTo` or `Transfer`, and they leave by a `TransferChecked` the PDA signs
//! by promotion inside an execution message.

use anyhow::{Context, Result};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_interface::instruction::{initialize_mint2, mint_to_checked, transfer_checked};
use spl_token_interface::state::{Account as TokenAccount, Mint};
use spl_token_interface::ID as TOKEN_PROGRAM;

/// Decimals of the mint the examples create: USDC's.
pub const DECIMALS: u8 = 6;

/// Creates a Token program mint with `payer` as its mint authority.
pub fn create_mint(client: &RpcClient, payer: &Keypair) -> Result<Address> {
    let mint = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(Mint::LEN)?;
    let instructions = [
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            rent,
            Mint::LEN as u64,
            &TOKEN_PROGRAM,
        ),
        initialize_mint2(
            &TOKEN_PROGRAM,
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            DECIMALS,
        )?,
    ];
    send(client, payer, &instructions, &[payer, &mint]).context("failed to create the mint")?;
    Ok(mint.pubkey())
}

/// Mints `amount` to `owner`'s associated token account, creating it if it
/// does not exist, and returns that account. `payer` is the mint authority.
pub fn mint_to(
    client: &RpcClient,
    payer: &Keypair,
    mint: &Address,
    owner: &Address,
    amount: u64,
) -> Result<Address> {
    let account = get_associated_token_address(owner, mint);
    let instructions = [
        create_associated_token_account_idempotent(&payer.pubkey(), owner, mint, &TOKEN_PROGRAM),
        mint_to_checked(
            &TOKEN_PROGRAM,
            mint,
            &account,
            &payer.pubkey(),
            &[],
            amount,
            DECIMALS,
        )?,
    ];
    send(client, payer, &instructions, &[payer]).context("failed to mint")?;
    Ok(account)
}

/// `owner`'s associated token account for `mint`.
pub fn associated_token_address(owner: &Address, mint: &Address) -> Address {
    get_associated_token_address(owner, mint)
}

/// The balance of a token account, in base units.
pub fn fetch_balance(client: &RpcClient, account: &Address) -> Result<u64> {
    let data = client
        .get_account(account)
        .with_context(|| format!("token account {account} not found"))?
        .data;
    let state =
        TokenAccount::unpack(&data).with_context(|| format!("{account} is not a token account"))?;
    Ok(state.amount)
}

/// `amount` in whole tokens, at [`DECIMALS`].
pub fn ui_amount(amount: u64) -> String {
    let unit = 10u64.pow(u32::from(DECIMALS));
    format!("{}.{:06}", amount / unit, amount % unit)
}

/// The instructions that move `amount` of `mint` from the PDA to `recipient`,
/// for the PDA to sign by promotion inside an execution message: create
/// `recipient`'s associated token account if it does not exist, with the PDA
/// paying the rent, then `TransferChecked` out of the PDA's own, with the PDA
/// as the owner.
pub fn withdraw(
    mint: &Address,
    pda: &Address,
    recipient: &Address,
    amount: u64,
) -> Result<[Instruction; 2]> {
    Ok([
        create_associated_token_account_idempotent(pda, recipient, mint, &TOKEN_PROGRAM),
        transfer_checked(
            &TOKEN_PROGRAM,
            &get_associated_token_address(pda, mint),
            mint,
            &get_associated_token_address(recipient, mint),
            pda,
            &[],
            amount,
            DECIMALS,
        )?,
    ])
}

fn send(
    client: &RpcClient,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<()> {
    let blockhash = client.get_latest_blockhash()?;
    let transaction =
        Transaction::new_signed_with_payer(instructions, Some(&payer.pubkey()), signers, blockhash);
    client.send_and_confirm_transaction(&transaction)?;
    Ok(())
}
