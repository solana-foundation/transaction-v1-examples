/**
 * Sends a transaction v1 transfer and decodes it back.
 *
 * Run with `just ts-send-decode`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    airdropFactory,
    appendTransactionMessageInstruction,
    areV1ConfigsEqual,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64Encoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    lamports,
    pipe,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';

import { assertV1Active } from './lib/feature';
import { formatTransactionConfig, json } from './lib/rpc';
import { createClients, sendAndConfirm } from './lib/send';
import { decodeTransactionVersion, EXAMPLE_CONFIG } from './lib/v1';

const decodeBase64 = (encoded: string) => decodeTransactionVersion(getBase64Encoder().encode(encoded));

const clients = createClients();

await assertV1Active(clients.rpc);

const payer = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
await airdropFactory(clients)({
    commitment: 'confirmed',
    lamports: lamports(1_000_000_000n),
    recipientAddress: payer.address,
});

const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();

// A v1 message is assembled through the same pipeline as a legacy or v0 one.
const message = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m =>
        appendTransactionMessageInstruction(
            getTransferSolInstruction({ amount: lamports(10_000_000n), destination: recipient.address, source: payer }),
            m,
        ),
    // The compute budget is a property of the message, so the instruction list
    // still holds only the transfer. `setTransactionMessageConfig` merges into
    // the existing config, so the four fields can be set one at a time instead.
    //
    // Alternatively, can manually set each item in the config:
    // setTransactionMessageComputeUnitLimit - writes `config.computeUnitLimit`
    // setTransactionMessageHeapSize - writes `config.heapSize`
    // setTransactionMessageLoadedAccountsDataSizeLimit - writes `config.loadedAccountsDataSizeLimit`
    // setTransactionMessagePriorityFeeLamports - writes `config.priorityFeeLamports`
    m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
);

const transaction = await signTransactionMessageWithSigners(message);
// Signing widens the lifetime to the blockhash / durable-nonce union, so the
// narrowing has to be reasserted before confirming by blockhash.
assertIsTransactionWithBlockhashLifetime(transaction);

const local = decodeBase64(getBase64EncodedWireTransaction(transaction));
console.log('== compiled locally ==');
console.log(`  version: ${local.version}`);
console.log(`  config:  ${json(local.config)}`);

const signature = await sendAndConfirm(clients, transaction);
console.log(`\n== sent ==\n  signature: ${getSignatureFromTransaction(transaction)}`);

// Omitting `maxSupportedTransactionVersion` caps the caller at legacy, and the
// server refuses the response rather than degrading the transaction.
console.log('\n== getTransaction without maxSupportedTransactionVersion ==');
try {
    await clients.rpc.getTransaction(signature, { commitment: 'confirmed', encoding: 'json' }).send();
    console.log('  unexpectedly succeeded');
} catch (error) {
    console.log(`  rejected: ${error instanceof Error ? error.message : String(error)}`);
}

const fetched = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
if (fetched === null) {
    throw new Error('the transaction just sent was not found');
}

console.log('\n== read back over JSON-RPC ==');
console.log(`  version: ${fetched.version}`);
console.log(formatTransactionConfig(fetched.transaction.message.transactionConfig));

const encoded = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 1 })
    .send();
if (encoded === null) {
    throw new Error('the transaction just sent was not found');
}

const remote = decodeBase64(encoded.transaction[0]);
console.log('\n== decoded from the base64 wire bytes ==');
console.log(`  version: ${remote.version}`);
console.log(`  config:  ${json(remote.config)}`);

// `areV1ConfigsEqual` treats an absent field and an explicit zero as distinct,
// which is the distinction the round trip has to preserve.
if (local.config === undefined || remote.config === undefined || !areV1ConfigsEqual(local.config, remote.config)) {
    throw new Error('the config did not survive the round trip');
}
console.log('  config round-tripped exactly');
