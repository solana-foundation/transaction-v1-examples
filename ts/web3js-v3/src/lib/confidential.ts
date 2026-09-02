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
import { type Address, createSolanaRpc, generateKeyPairSigner } from '@solana/kit';
import { Connection, Keypair } from '@solana/web3.js';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

import { fundedKeypair, RPC_URL, sendV1Transaction, type V1InstructionInput } from './v1';

export const MINT_DECIMALS = 2;

type ConfidentialKeys = {
    aesKey: AeKey;
    elgamalKeypair: ElGamalKeypair;
};

export type ConfidentialParty = ConfidentialKeys & {
    owner: Keypair;
    token: Address;
};

export type ConfidentialContext = {
    connection: Connection;
    payer: Keypair;
    rpc: ReturnType<typeof createSolanaRpc>;
};

export async function createConfidentialContext(airdrop: number): Promise<ConfidentialContext> {
    const connection = new Connection(RPC_URL, 'confirmed');
    return { connection, payer: await fundedKeypair(connection, airdrop), rpc: createSolanaRpc(RPC_URL) };
}

const send = (context: ConfidentialContext, inputs: ReadonlyArray<V1InstructionInput>) =>
    sendV1Transaction(context.connection, context.payer, inputs);

export async function fetchPartyBalance(context: ConfidentialContext, party: ConfidentialParty) {
    return await fetchConfidentialTransferBalance({
        aesKey: party.aesKey,
        elgamalSecretKey: party.elgamalKeypair.secret(),
        rpc: context.rpc,
        token: party.token,
    });
}

async function deriveConfidentialKeys(owner: Keypair, mint: Address): Promise<ConfidentialKeys> {
    const [elgamal, aes] = await Promise.all([
        deriveElGamalKeypairForOwnerMint({ mint, owner: owner.address, signer: owner }),
        deriveAeKeyForOwnerMint({ mint, owner: owner.address, signer: owner }),
    ]);
    return {
        aesKey: AeKey.fromBytes(aes),
        elgamalKeypair: ElGamalKeypair.fromSecretKey(ElGamalSecretKey.fromBytes(elgamal.secretKey)),
    };
}

export async function createConfidentialMint(context: ConfidentialContext): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await send(context, [
        await getCreateMintInstructionPlan(
            { getMinimumBalance: space => context.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send() },
            {
                decimals: MINT_DECIMALS,
                extensions: [
                    extension('ConfidentialTransferMint', {
                        auditorElgamalPubkey: null,
                        authority: context.payer.address,
                        autoApproveNewAccounts: true,
                    }),
                ],
                mintAuthority: context.payer,
                newMint: mint,
                payer: context.payer,
            },
        ),
    ]);
    return mint.address;
}

export async function createConfidentialParty(
    context: ConfidentialContext,
    mint: Address,
    owner: Keypair,
): Promise<ConfidentialParty> {
    const keys = await deriveConfidentialKeys(owner, mint);
    const [token] = await findAssociatedTokenPda({
        mint,
        owner: owner.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    await send(context, [
        await getCreateConfidentialTransferAccountInstructionPlan({
            aesKey: keys.aesKey,
            elgamalKeypair: keys.elgamalKeypair,
            mint,
            owner,
            payer: context.payer,
            rpc: context.rpc,
        }),
    ]);
    return { ...keys, owner, token };
}

export async function applyPendingBalance(context: ConfidentialContext, party: ConfidentialParty): Promise<void> {
    const account = await fetchToken(context.rpc, party.token);
    await send(context, [
        getApplyConfidentialPendingBalanceInstructionFromToken({
            aesKey: party.aesKey,
            authority: party.owner,
            elgamalSecretKey: party.elgamalKeypair.secret(),
            token: party.token,
            tokenAccount: account.data,
        }),
    ]);
}

export async function fundConfidentially(
    context: ConfidentialContext,
    mint: Address,
    party: ConfidentialParty,
    amount: bigint,
): Promise<void> {
    await send(context, [
        await getMintToATAInstructionPlanAsync({
            amount,
            decimals: MINT_DECIMALS,
            mint,
            mintAuthority: context.payer,
            owner: party.owner.address,
            payer: context.payer,
        }),
    ]);
    await send(context, [
        getConfidentialDepositInstruction({
            amount,
            authority: party.owner,
            decimals: MINT_DECIMALS,
            mint,
            token: party.token,
        }),
    ]);
    await applyPendingBalance(context, party);
}
