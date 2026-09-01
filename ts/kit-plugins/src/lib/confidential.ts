/**
 * Confidential transfer (Token-2022) scaffolding, driven by a plugin client.
 *
 * This is the `ts/kit/src/lib/confidential.ts` setup with the hand-rolled
 * transaction planner and executor removed. Every setup step here hands its
 * {@link InstructionPlan} straight to `client.sendTransactions`, which plans it
 * into as few v1 messages as the size limit allows, estimates each one's
 * resource limits, signs, sends, and confirms.
 */

import {
    extension,
    fetchToken,
    findAssociatedTokenPda,
    getConfidentialDepositInstruction,
    getCreateMintInstructionPlan,
    getMintToATAInstructionPlanAsync,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
    deriveAeKeyForOwnerMint,
    deriveElGamalKeypairForOwnerMint,
    fetchConfidentialTransferBalance,
    getApplyConfidentialPendingBalanceInstructionFromToken,
    getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import {
    type Address,
    generateKeyPairSigner,
    type MessagePartialSigner,
    singleInstructionPlan,
    type TransactionSigner,
} from '@solana/kit';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

import type { V1Client } from './client';

export const MINT_DECIMALS = 2;

type ConfidentialKeys = {
    aesKey: AeKey;
    elgamalKeypair: ElGamalKeypair;
};

export type ConfidentialSigner = MessagePartialSigner & TransactionSigner;

export type ConfidentialParty = ConfidentialKeys & {
    owner: ConfidentialSigner;
    token: Address;
};

export async function fetchPartyBalance(client: V1Client, party: ConfidentialParty) {
    return await fetchConfidentialTransferBalance({
        aesKey: party.aesKey,
        elgamalSecretKey: party.elgamalKeypair.secret(),
        rpc: client.rpc,
        token: party.token,
    });
}

async function deriveConfidentialKeys(owner: ConfidentialSigner, mint: Address): Promise<ConfidentialKeys> {
    const [elgamal, aes] = await Promise.all([
        deriveElGamalKeypairForOwnerMint({ mint, owner: owner.address, signer: owner }),
        deriveAeKeyForOwnerMint({ mint, owner: owner.address, signer: owner }),
    ]);
    return {
        aesKey: AeKey.fromBytes(aes),
        elgamalKeypair: ElGamalKeypair.fromSecretKey(ElGamalSecretKey.fromBytes(elgamal.secretKey)),
    };
}

export async function createConfidentialMint(client: V1Client): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await client.sendTransactions(
        await getCreateMintInstructionPlan(client, {
            decimals: MINT_DECIMALS,
            extensions: [
                extension('ConfidentialTransferMint', {
                    auditorElgamalPubkey: null,
                    authority: client.payer.address,
                    autoApproveNewAccounts: true,
                }),
            ],
            mintAuthority: client.payer,
            newMint: mint,
            payer: client.payer,
        }),
    );
    return mint.address;
}

export async function createConfidentialParty(
    client: V1Client,
    mint: Address,
    owner: ConfidentialSigner,
): Promise<ConfidentialParty> {
    const keys = await deriveConfidentialKeys(owner, mint);
    const [token] = await findAssociatedTokenPda({
        mint,
        owner: owner.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    await client.sendTransactions(
        await getCreateConfidentialTransferAccountInstructionPlan({
            aesKey: keys.aesKey,
            elgamalKeypair: keys.elgamalKeypair,
            mint,
            owner,
            payer: client.payer,
            rpc: client.rpc,
        }),
    );
    return { ...keys, owner, token };
}

export async function applyPendingBalance(client: V1Client, party: ConfidentialParty): Promise<void> {
    const account = await fetchToken(client.rpc, party.token);
    await client.sendTransactions(
        singleInstructionPlan(
            getApplyConfidentialPendingBalanceInstructionFromToken({
                aesKey: party.aesKey,
                authority: party.owner,
                elgamalSecretKey: party.elgamalKeypair.secret(),
                token: party.token,
                tokenAccount: account.data,
            }),
        ),
    );
}

/**
 * Mints `amount` public tokens to a party and converts them to a confidential
 * available balance.
 *
 * Depositing encrypts the amount but does not hide it — the deposit instruction
 * states it in the clear, and it is the transfer that follows that nobody can
 * read.
 */
export async function fundConfidentially(
    client: V1Client,
    mint: Address,
    party: ConfidentialParty,
    amount: bigint,
): Promise<void> {
    await client.sendTransactions(
        await getMintToATAInstructionPlanAsync({
            amount,
            decimals: MINT_DECIMALS,
            mint,
            mintAuthority: client.payer,
            owner: party.owner.address,
            payer: client.payer,
        }),
    );
    await client.sendTransactions(
        singleInstructionPlan(
            getConfidentialDepositInstruction({
                amount,
                authority: party.owner,
                decimals: MINT_DECIMALS,
                mint,
                token: party.token,
            }),
        ),
    );
    await applyPendingBalance(client, party);
}
