/** Funding keys, checking the programs are deployed, and waiting out a blockhash. */

import {
    airdropFactory,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    type Blockhash,
    createTransactionMessage,
    fetchEncodedAccount,
    generateKeyPairSigner,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';

import { ED25519_SIGNER_PROGRAM_ADDRESS, MESSAGE_EXECUTOR_PROGRAM_ADDRESS, NONCE_PROGRAM_ADDRESS } from '../client';
import type { Clients } from './rpc';

/** The three programs the examples call, with the names their crates use. */
export const PROGRAMS = [
    ['SPL Nonce', NONCE_PROGRAM_ADDRESS],
    ['SPL Ed25519 Signer', ED25519_SIGNER_PROGRAM_ADDRESS],
    ['SPL Message Executor', MESSAGE_EXECUTOR_PROGRAM_ADDRESS],
] as const;

/**
 * Throws unless all three programs are deployed on the cluster behind `rpc`.
 *
 * Checked up front so a validator started without them names itself, rather
 * than surfacing later as a `ProgramAccountNotFound` on the relay.
 */
export async function assertProgramsDeployed(rpc: Clients['rpc']): Promise<void> {
    for (const [name, programAddress] of PROGRAMS) {
        const account = await fetchEncodedAccount(rpc, programAddress);
        if (!account.exists || !account.executable) {
            throw new Error(
                `the ${name} program (${programAddress}) is not deployed on this cluster; start a validator with \`just validator-start\``,
            );
        }
    }
}

/** Creates a signer funded by airdrop, waiting for the airdrop to confirm. */
export async function fundedSigner(clients: Clients, amount: bigint): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    await airdropFactory(clients)({
        commitment: 'confirmed',
        lamports: lamports(amount),
        recipientAddress: signer.address,
    });
    return signer;
}

/**
 * Resolves once `blockhash` can no longer be used in a transaction.
 *
 * A blockhash lives for 150 slots, about a minute on a local validator. The
 * examples capture one when the cold key signs and wait it out before
 * relaying, which is the shortest demonstration that the signed artifact does
 * not expire with it.
 */
export async function waitForBlockhashExpiry(rpc: Clients['rpc'], blockhash: Blockhash): Promise<void> {
    for (;;) {
        const { value: valid } = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send();
        if (!valid) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
}

/**
 * Sends `instructions` in one legacy transaction paid by `payer`, signed by
 * every signer they name, and waits for it to confirm. For setup steps that
 * are not the point of an example.
 */
export async function sendInstructions(
    clients: Clients,
    payer: KeyPairSigner,
    instructions: Instruction[],
): Promise<void> {
    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const transaction = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 'legacy' }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
            m => appendTransactionMessageInstructions(instructions, m),
        ),
    );
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirmTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
}
