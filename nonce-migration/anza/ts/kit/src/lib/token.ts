/**
 * Token helpers for the examples.
 *
 * The PDA owns token accounts the way any wallet does. Its associated token
 * account is derived from its address, tokens arrive there by an ordinary
 * `MintTo` or `Transfer`, and they leave by a `TransferChecked` the PDA signs
 * by promotion inside an execution message.
 */

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address } from '@solana/kit';

/** Decimals of the mint the examples create: USDC's. */
export const DECIMALS = 6;

/** `owner`'s associated token account for `mint`. */
export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
    const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return address;
}

/** `amount` in whole tokens, at {@link DECIMALS}. */
export function uiAmount(amount: bigint): string {
    const unit = 10n ** BigInt(DECIMALS);
    return `${amount / unit}.${(amount % unit).toString().padStart(DECIMALS, '0')}`;
}
