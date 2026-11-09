/**
 * The flow being replaced: a System durable nonce transaction.
 *
 * Here for comparison. The cold key owns the funds, creates a nonce account
 * with the System program, and signs a transaction whose first instruction is
 * `AdvanceNonceAccount` and whose blockhash slot holds the nonce value. That
 * transaction is sent as-is, whenever.
 */

import {
    fetchNonce as fetchSystemNonceAccount,
    getCreateAccountInstruction,
    getInitializeNonceAccountInstruction,
    getNonceSize,
    getTransferSolInstruction,
    SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import {
    type Address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    assertIsTransactionWithDurableNonceLifetime,
    createTransactionMessage,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    type KeyPairSigner,
    lamports,
    type Nonce,
    pipe,
    sendAndConfirmDurableNonceTransactionFactory,
    sendAndConfirmTransactionFactory,
    type SendableTransaction,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLifetimeUsingDurableNonce,
    type Signature,
    signTransactionMessageWithSigners,
    type Transaction,
    type TransactionWithDurableNonceLifetime,
} from '@solana/kit';

import type { Clients } from './rpc';

/** Creates a System nonce account whose authority is `cold`, paid for by `cold`. */
export async function createSystemNonceAccount(clients: Clients, cold: KeyPairSigner): Promise<Address> {
    const nonceAccount = await generateKeyPairSigner();
    const rent = await clients.rpc.getMinimumBalanceForRentExemption(BigInt(getNonceSize())).send();
    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const message = pipe(
        createTransactionMessage({ version: 'legacy' }),
        m => setTransactionMessageFeePayerSigner(cold, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m =>
            appendTransactionMessageInstructions(
                [
                    getCreateAccountInstruction({
                        lamports: rent,
                        newAccount: nonceAccount,
                        payer: cold,
                        programAddress: SYSTEM_PROGRAM_ADDRESS,
                        space: BigInt(getNonceSize()),
                    }),
                    getInitializeNonceAccountInstruction({
                        nonceAccount: nonceAccount.address,
                        nonceAuthority: cold.address,
                    }),
                ],
                m,
            ),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirmTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
    return nonceAccount.address;
}

/** Reads the value a System nonce account currently holds. */
export async function fetchSystemNonce(rpc: Clients['rpc'], nonceAccount: Address): Promise<Nonce> {
    const { data } = await fetchSystemNonceAccount(rpc, nonceAccount, { commitment: 'confirmed' });
    return data.blockhash as string as Nonce;
}

/** A signed durable nonce transaction. */
export type DurableNonceTransaction = SendableTransaction & Transaction & TransactionWithDurableNonceLifetime;

/** Signs a durable nonce transfer from `cold`. Nothing is sent. */
export async function signDurableNonceTransfer(
    cold: KeyPairSigner,
    nonceAccount: Address,
    nonce: Nonce,
    recipient: Address,
    amount: bigint,
): Promise<DurableNonceTransaction> {
    const message = pipe(
        createTransactionMessage({ version: 'legacy' }),
        m => setTransactionMessageFeePayerSigner(cold, m),
        m =>
            setTransactionMessageLifetimeUsingDurableNonce(
                { nonce, nonceAccountAddress: nonceAccount, nonceAuthorityAddress: cold.address },
                m,
            ),
        m =>
            appendTransactionMessageInstruction(
                getTransferSolInstruction({ amount: lamports(amount), destination: recipient, source: cold }),
                m,
            ),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithDurableNonceLifetime(transaction);
    return transaction;
}

/** Sends a durable nonce transaction and waits for it to confirm. */
export async function sendDurableNonceTransaction(
    clients: Clients,
    transaction: DurableNonceTransaction,
): Promise<Signature> {
    await sendAndConfirmDurableNonceTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
}
