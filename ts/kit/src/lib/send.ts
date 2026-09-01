/** Building, signing, and sending v1 transactions with `@solana/kit`. */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    airdropFactory,
    appendTransactionMessageInstruction,
    assertIsTransactionWithBlockhashLifetime,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    lamports,
    pipe,
    type Rpc,
    type RpcSubscriptions,
    sendAndConfirmTransactionFactory,
    type Signature,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type SendableTransaction,
    signTransactionMessageWithSigners,
    type SolanaRpcApi,
    type SolanaRpcSubscriptionsApi,
    type Transaction,
    type TransactionWithBlockhashLifetime,
} from '@solana/kit';

import { DEFAULT_RPC_SUBSCRIPTIONS_URL, DEFAULT_RPC_URL } from './rpc';
import { EXAMPLE_CONFIG } from './v1';

/** A signed, size-checked transaction ready for `sendAndConfirmTransaction`. */
export type SendableV1Transaction = SendableTransaction & Transaction & TransactionWithBlockhashLifetime;

export type Clients = {
    rpc: Rpc<SolanaRpcApi>;
    rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

/** Connects to the endpoints named by `TXV1_RPC_URL` and `TXV1_RPC_SUBSCRIPTIONS_URL`. */
export function createClients(): Clients {
    return {
        rpc: createSolanaRpc(process.env.TXV1_RPC_URL ?? DEFAULT_RPC_URL),
        rpcSubscriptions: createSolanaRpcSubscriptions(
            process.env.TXV1_RPC_SUBSCRIPTIONS_URL ?? DEFAULT_RPC_SUBSCRIPTIONS_URL,
        ),
    };
}

/**
 * Builds and signs a v1 SOL transfer from a freshly airdropped payer.
 *
 * The compute budget travels in the message config, so no ComputeBudget program
 * instructions are compiled in.
 */
export async function buildV1Transfer(clients: Clients): Promise<SendableV1Transaction> {
    const payer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    await airdropFactory(clients)({
        commitment: 'confirmed',
        lamports: lamports(1_000_000_000n),
        recipientAddress: payer.address,
    });

    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayerSigner(payer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m =>
            appendTransactionMessageInstruction(
                getTransferSolInstruction({
                    amount: lamports(10_000_000n),
                    destination: recipient.address,
                    source: payer,
                }),
                m,
            ),
        // The whole budget lands in `message.config`, so the instruction list
        // still holds only the transfer.
        m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
    );

    const signedTransaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);
    return signedTransaction;
}

/** Sends a signed transaction and waits for it to confirm. */
export async function sendAndConfirm(clients: Clients, transaction: SendableV1Transaction): Promise<Signature> {
    await sendAndConfirmTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
}

/** Sends a v1 transfer and returns the slot it landed in. */
export async function sendV1TransferAndGetSlot(clients: Clients): Promise<{ signature: Signature; slot: bigint }> {
    const signature = await sendAndConfirm(clients, await buildV1Transfer(clients));
    const [status] = await clients.rpc
        .getSignatureStatuses([signature])
        .send()
        .then(result => result.value);
    if (!status) {
        throw new Error('no status for the transaction just sent');
    }
    return { signature, slot: status.slot };
}
