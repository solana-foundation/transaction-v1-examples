/**
 * Token accounts for the examples: a mint and balances.
 *
 * The PDA owns token accounts the way any wallet does. Its associated token
 * account is derived from its address, tokens arrive there by an ordinary
 * `MintTo` or `Transfer`, and they leave by a `TransferChecked` the PDA signs
 * by promotion inside an execution message.
 */

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { type Address, generateKeyPairSigner } from '@solana/kit';

import type { Client } from './cluster';

/** Decimals of the mint the examples create: USDC's. */
export const DECIMALS = 6;

/** Creates a Token program mint with the client's payer as its mint authority. */
export async function createMint(client: Client): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await client.token.instructions
        .createMint({ decimals: DECIMALS, mintAuthority: client.payer.address, newMint: mint })
        .sendTransactions();
    return mint.address;
}

/**
 * Mints `amount` to `owner`'s associated token account, creating it if it
 * does not exist, and returns that account. The client's payer is the mint
 * authority.
 */
export async function mintToAta(client: Client, mint: Address, owner: Address, amount: bigint): Promise<Address> {
    await client.token.instructions
        .mintToATA({ amount, decimals: DECIMALS, mint, mintAuthority: client.payer, owner })
        .sendTransactions();
    return await associatedTokenAddress(owner, mint);
}

/** `owner`'s associated token account for `mint`. */
export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
    const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return address;
}

/** The balance of a token account, in base units. */
export async function fetchBalance(client: Client, account: Address): Promise<bigint> {
    const { data } = await client.token.accounts.token.fetch(account);
    return data.amount;
}

/** `amount` in whole tokens, at {@link DECIMALS}. */
export function uiAmount(amount: bigint): string {
    const unit = 10n ** BigInt(DECIMALS);
    return `${amount / unit}.${(amount % unit).toString().padStart(DECIMALS, '0')}`;
}
