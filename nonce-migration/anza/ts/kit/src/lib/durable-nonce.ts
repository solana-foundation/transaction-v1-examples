/**
 * The flow being replaced: a System durable nonce transaction.
 *
 * Here for comparison. The cold key owns the funds, creates a nonce account
 * with the System program, and signs a transaction whose first instruction is
 * `AdvanceNonceAccount` and whose blockhash slot holds the nonce value. That
 * transaction is sent as-is, whenever.
 */

import { getNonceSize, getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
    type Address,
    appendTransactionMessageInstruction,
    assertIsTransactionWithDurableNonceLifetime,
    createTransactionMessage,
    generateKeyPairSigner,
    type KeyPairSigner,
    lamports,
    type Nonce,
    pipe,
    type SendableTransaction,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingDurableNonce,
    signTransactionMessageWithSigners,
    type Transaction,
    type TransactionWithDurableNonceLifetime,
    type V1TransactionConfig,
} from '@solana/kit';

import type { Client } from './cluster';

/** Creates a System nonce account owned and paid for by the client's payer, the cold key. */
export async function createDurableNonceAccount(client: Client): Promise<Address> {
    const nonceAccount = await generateKeyPairSigner();
    await client.sendTransaction([
        client.system.instructions.createAccount({
            lamports: await client.getMinimumBalance(getNonceSize()),
            newAccount: nonceAccount,
            programAddress: SYSTEM_PROGRAM_ADDRESS,
            space: getNonceSize(),
        }),
        client.system.instructions.initializeNonceAccount({
            nonceAccount: nonceAccount.address,
            nonceAuthority: client.payer.address,
        }),
    ]);
    return nonceAccount.address;
}

/**
 * The budget of the durable nonce transfer: two System instructions cost 300
 * compute units, and the cold key is offline and cannot simulate.
 */
const DURABLE_NONCE_CONFIG: V1TransactionConfig = {
    computeUnitLimit: 1_000,
    loadedAccountsDataSizeLimit: 64 * 1024,
};

/** A signed durable nonce transaction. */
export type DurableNonceTransaction = SendableTransaction & Transaction & TransactionWithDurableNonceLifetime;

/**
 * Signs a durable nonce transfer from `cold`, using the value its System
 * nonce account holds, as the account decoder returns it. Nothing is sent.
 *
 * The message is v1, and a durable nonce works on it as it does on a legacy
 * one: the nonce sits in the blockhash slot and `AdvanceNonceAccount` comes
 * first.
 */
export async function signDurableNonceTransfer(
    cold: KeyPairSigner,
    nonceAccount: Address,
    nonce: Address,
    recipient: Address,
    amount: bigint,
): Promise<DurableNonceTransaction> {
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayerSigner(cold, m),
        m =>
            setTransactionMessageLifetimeUsingDurableNonce(
                {
                    nonce: nonce as string as Nonce,
                    nonceAccountAddress: nonceAccount,
                    nonceAuthorityAddress: cold.address,
                },
                m,
            ),
        m =>
            appendTransactionMessageInstruction(
                getTransferSolInstruction({ amount: lamports(amount), destination: recipient, source: cold }),
                m,
            ),
        m => setTransactionMessageConfig(DURABLE_NONCE_CONFIG, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithDurableNonceLifetime(transaction);
    return transaction;
}
