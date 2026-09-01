/**
 * Confidential transfers (Token-2022) driven by transaction v1.
 *
 * A confidential transfer is three zero-knowledge proofs plus the transfer
 * itself. Each proof is written into a context state account owned by the ZK
 * ElGamal Proof program, the transfer instruction reads all three, and the three
 * accounts are closed afterwards to reclaim their rent — ten instructions and
 * roughly two kilobytes of proof bytes, more than the legacy 1,232-byte limit
 * can hold. Version 1 raises the limit to 4,096, enough for the whole
 * {@link InstructionPlan} to land in one transaction that either happens or does
 * not, with no half-finished state to unwind.
 *
 * This module holds the scaffolding a transfer needs before it can run: key
 * derivation, and the mint and account setup. The transfer itself — building the
 * one v1 message, sizing it, signing it, and sending it — is done in the open in
 * `ts/src/confidential-transfer.ts`.
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
    fetchConfidentialTransferBalance,
    deriveElGamalKeypairForOwnerMint,
    getApplyConfidentialPendingBalanceInstructionFromToken,
    getCreateConfidentialTransferAccountInstructionPlan,
} from '@solana-program/token-2022/confidential';
import {
    type Address,
    createTransactionMessage,
    createTransactionPlanExecutor,
    createTransactionPlanner,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    type InstructionPlan,
    type MessagePartialSigner,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessagePriorityFeeLamports,
    signTransactionMessageWithSigners,
    singleInstructionPlan,
    type TransactionSigner,
} from '@solana/kit';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';

import type { Clients, SendableV1Transaction } from './send';

export const MINT_DECIMALS = 2;

const PRIORITY_FEE_LAMPORTS = 5_000n;

/**
 * The ElGamal and AES keys a confidential account is configured with.
 */
type ConfidentialKeys = {
    aesKey: AeKey;
    elgamalKeypair: ElGamalKeypair;
};

/**
 * A signer that can sign both transactions and off-chain messages.
 */
export type ConfidentialSigner = MessagePartialSigner & TransactionSigner;

/** One party to a confidential transfer: an owner, their token account, and their keys. */
export type ConfidentialParty = ConfidentialKeys & {
    owner: ConfidentialSigner;
    token: Address;
};

/** Reads and decrypts a party's confidential balances. */
export async function fetchPartyBalance(clients: Clients, party: ConfidentialParty) {
    return await fetchConfidentialTransferBalance({
        aesKey: party.aesKey,
        elgamalSecretKey: party.elgamalKeypair.secret(),
        rpc: clients.rpc,
        token: party.token,
    });
}

/**
 * Derives a party's confidential keys from an off-chain signature.
 */
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

/**
 * Packs a setup instruction plan into as few v1 messages as the size limit
 * allows, then measures each one's resource limits, signs it, and sends it.
 *
 * The planner fills the resource limits with provisory placeholders rather than
 * choosing them. Each occupies the four bytes its measured value will, so the
 * message packs at its final size, and the executor substitutes the measurements.
 *
 * Both the blockhash and the measurement are left to execution time. A plan can
 * take longer to build than a blockhash lives, and the estimator simulates, so it
 * needs a message that already has a lifetime.
 */
async function sendSetupPlan(clients: Clients, payer: ConfidentialSigner, plan: InstructionPlan): Promise<void> {
    const planner = createTransactionPlanner({
        createTransactionMessage: () =>
            pipe(
                createTransactionMessage({ version: 1 }),
                message => setTransactionMessageFeePayerSigner(payer, message),
                message => setTransactionMessagePriorityFeeLamports(PRIORITY_FEE_LAMPORTS, message),
                fillTransactionMessageProvisoryResourceLimits,
            ),
    });
    const sendAndConfirm = sendAndConfirmTransactionFactory(clients);
    const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(
        estimateResourceLimitsFactory({ rpc: clients.rpc }),
    );
    const executor = createTransactionPlanExecutor({
        executeTransactionMessage: async (context, message) => {
            const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
            const transaction = await signTransactionMessageWithSigners(
                await estimateAndSetResourceLimits(
                    setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
                    { commitment: 'confirmed' },
                ),
            );
            context.transaction = transaction;
            const signature = getSignatureFromTransaction(transaction);
            await sendAndConfirm(transaction as SendableV1Transaction, { commitment: 'confirmed' });
            return { signature, transaction };
        },
    });
    await executor(await planner(plan));
}

/**
 * Creates a mint whose accounts can hold confidential balances.
 */
export async function createConfidentialMint(clients: Clients, payer: ConfidentialSigner): Promise<Address> {
    const mint = await generateKeyPairSigner();
    await sendSetupPlan(
        clients,
        payer,
        await getCreateMintInstructionPlan(
            { getMinimumBalance: space => clients.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send() },
            {
                decimals: MINT_DECIMALS,
                extensions: [
                    extension('ConfidentialTransferMint', {
                        auditorElgamalPubkey: null,
                        authority: payer.address,
                        autoApproveNewAccounts: true,
                    }),
                ],
                mintAuthority: payer,
                newMint: mint,
                payer,
            },
        ),
    );
    return mint.address;
}

/**
 * Creates and configures one party's confidential token account.
 */
export async function createConfidentialParty(
    clients: Clients,
    payer: ConfidentialSigner,
    mint: Address,
    owner: ConfidentialSigner,
): Promise<ConfidentialParty> {
    const keys = await deriveConfidentialKeys(owner, mint);
    const [token] = await findAssociatedTokenPda({
        mint,
        owner: owner.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    await sendSetupPlan(
        clients,
        payer,
        await getCreateConfidentialTransferAccountInstructionPlan({
            aesKey: keys.aesKey,
            elgamalKeypair: keys.elgamalKeypair,
            mint,
            owner,
            payer,
            rpc: clients.rpc,
        }),
    );
    return { ...keys, owner, token };
}

/**
 * Moves a party's pending balance into their available balance.
 * */
export async function applyPendingBalance(
    clients: Clients,
    payer: ConfidentialSigner,
    party: ConfidentialParty,
): Promise<void> {
    const account = await fetchToken(clients.rpc, party.token);
    await sendSetupPlan(
        clients,
        payer,
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
    clients: Clients,
    payer: ConfidentialSigner,
    mint: Address,
    party: ConfidentialParty,
    amount: bigint,
): Promise<void> {
    await sendSetupPlan(
        clients,
        payer,
        await getMintToATAInstructionPlanAsync({
            amount,
            decimals: MINT_DECIMALS,
            mint,
            mintAuthority: payer,
            owner: party.owner.address,
            payer,
        }),
    );
    await sendSetupPlan(
        clients,
        payer,
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
    await applyPendingBalance(clients, payer, party);
}
