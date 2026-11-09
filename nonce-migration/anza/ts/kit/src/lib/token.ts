/**
 * Token accounts for the examples: a mint, balances, and the instructions a
 * PDA uses to move tokens.
 *
 * The PDA owns token accounts the way any wallet does. Its associated token
 * account is derived from its address, tokens arrive there by an ordinary
 * `MintTo` or `Transfer`, and they leave by a `TransferChecked` the PDA signs
 * by promotion inside an execution message.
 */

import { getCreateAccountInstruction } from '@solana-program/system';
import {
    fetchToken,
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstruction,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToCheckedInstruction,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    type Address,
    createNoopSigner,
    generateKeyPairSigner,
    type Instruction,
    type KeyPairSigner,
} from '@solana/kit';

import { sendInstructions } from './cluster';
import type { Clients } from './rpc';

/** Decimals of the mint the examples create: USDC's. */
export const DECIMALS = 6;

/** Creates a Token program mint with `payer` as its mint authority. */
export async function createMint(clients: Clients, payer: KeyPairSigner): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    const rent = await clients.rpc.getMinimumBalanceForRentExemption(space).send();
    await sendInstructions(clients, payer, [
        getCreateAccountInstruction({
            lamports: rent,
            newAccount: mint,
            payer,
            programAddress: TOKEN_PROGRAM_ADDRESS,
            space,
        }),
        getInitializeMint2Instruction({
            decimals: DECIMALS,
            freezeAuthority: null,
            mint: mint.address,
            mintAuthority: payer.address,
        }),
    ]);
    return mint.address;
}

/**
 * Mints `amount` to `owner`'s associated token account, creating it if it
 * does not exist, and returns that account. `payer` is the mint authority.
 */
export async function mintTo(
    clients: Clients,
    payer: KeyPairSigner,
    mint: Address,
    owner: Address,
    amount: bigint,
): Promise<Address> {
    const account = await associatedTokenAddress(owner, mint);
    await sendInstructions(clients, payer, [
        getCreateAssociatedTokenIdempotentInstruction({ ata: account, mint, owner, payer }),
        getMintToCheckedInstruction({ amount, decimals: DECIMALS, mint, mintAuthority: payer, token: account }),
    ]);
    return account;
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

/**
 * The instructions that move `amount` of `mint` from the PDA to `recipient`,
 * for the PDA to sign by promotion inside an execution message: create
 * `recipient`'s associated token account if it does not exist, with the PDA
 * paying the rent, then `TransferChecked` out of the PDA's own, with the PDA
 * as the owner.
 *
 * The builders want a signer wherever a key would sign, and the PDA has no
 * key. A noop signer carries its address and the signer role without ever
 * producing a signature; the Signer program supplies that at execution time.
 */
export async function withdraw(
    mint: Address,
    pda: Address,
    recipient: Address,
    amount: bigint,
): Promise<Instruction[]> {
    const signer = createNoopSigner(pda);
    return [
        getCreateAssociatedTokenIdempotentInstruction({
            ata: await associatedTokenAddress(recipient, mint),
            mint,
            owner: recipient,
            payer: signer,
        }),
        getTransferCheckedInstruction({
            amount,
            authority: signer,
            decimals: DECIMALS,
            destination: await associatedTokenAddress(recipient, mint),
            mint,
            source: await associatedTokenAddress(pda, mint),
        }),
    ];
}
