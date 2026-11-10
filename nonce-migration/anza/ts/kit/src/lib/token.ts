/**
 * Token accounts for the examples: a mint and balances.
 *
 * The PDA owns token accounts the way any wallet does. Its associated token
 * account is derived from its address, tokens arrive there by an ordinary
 * `MintTo` or `Transfer`, and they leave by a `TransferChecked` the PDA signs
 * by promotion inside an execution message.
 */

import {
    fetchToken,
    findAssociatedTokenPda,
    getCreateMintInstructionPlan,
    getMintToATAInstructionPlanAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    type Address,
    createClientWithGetMinimumBalanceFromRpc,
    generateKeyPairSigner,
    type KeyPairSigner,
} from '@solana/kit';

import { sendTransactions } from './cluster';
import type { Clients } from './rpc';

/** Decimals of the mint the examples create: USDC's. */
export const DECIMALS = 6;

/** Creates a Token program mint with `payer` as its mint authority. */
export async function createMint(clients: Clients, payer: KeyPairSigner): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await sendTransactions(
        clients,
        payer,
        await getCreateMintInstructionPlan(createClientWithGetMinimumBalanceFromRpc(clients.rpc), {
            decimals: DECIMALS,
            mintAuthority: payer.address,
            newMint: mint,
            payer,
        }),
    );
    return mint.address;
}

/**
 * Mints `amount` to `owner`'s associated token account, creating it if it
 * does not exist, and returns that account. `payer` is the mint authority.
 */
export async function mintToAta(
    clients: Clients,
    payer: KeyPairSigner,
    mint: Address,
    owner: Address,
    amount: bigint,
): Promise<Address> {
    await sendTransactions(
        clients,
        payer,
        await getMintToATAInstructionPlanAsync({
            amount,
            decimals: DECIMALS,
            mint,
            mintAuthority: payer,
            owner,
            payer,
        }),
    );
    return await associatedTokenAddress(owner, mint);
}

/** `owner`'s associated token account for `mint`. */
export async function associatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
    const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return address;
}

/** The balance of a token account, in base units. */
export async function fetchBalance(rpc: Clients['rpc'], account: Address): Promise<bigint> {
    const { data } = await fetchToken(rpc, account, { commitment: 'confirmed' });
    return data.amount;
}

/** `amount` in whole tokens, at {@link DECIMALS}. */
export function uiAmount(amount: bigint): string {
    const unit = 10n ** BigInt(DECIMALS);
    return `${amount / unit}.${(amount % unit).toString().padStart(DECIMALS, '0')}`;
}
