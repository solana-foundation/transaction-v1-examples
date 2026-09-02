// Run with `just w3v3-send-decode` while a validator is up (`just validator-start`).

import { Connection, Keypair, LAMPORTS_PER_SOL, MessageV1, SystemProgram, VersionedTransaction } from '@solana/web3.js';

import { fundedKeypair, json, RPC_URL, sendV1Transaction } from './lib/v1';

const connection = new Connection(RPC_URL, 'confirmed');
const payer = await fundedKeypair(connection, LAMPORTS_PER_SOL);
const recipient = await Keypair.generate();

const { signature, transaction } = await sendV1Transaction(
    connection,
    payer,
    [
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            lamports: 10_000_000,
            toPubkey: recipient.publicKey,
        }),
    ],
    { computeUnitLimit: 20_000, heapSize: 64 * 1024, loadedAccountsDataSizeLimit: 64 * 1024 },
);

console.log('== sent ==');
console.log(`  signature: ${signature}`);
console.log(`  version:   ${transaction.version}`);
console.log(`  size:      ${transaction.serialize().length} bytes`);

console.log('\n== getTransaction with maxSupportedTransactionVersion 0 ==');
try {
    await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    console.log('  unexpectedly succeeded');
} catch (error) {
    console.log(`  rejected: ${error instanceof Error ? error.message : String(error)}`);
}

const fetched = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });
if (fetched === null) {
    throw new Error(`transaction ${signature} was not found`);
}

const { message } = fetched.transaction;
console.log('\n== read back ==');
console.log(`  version: ${message.version} (${fetched.version} in the response envelope)`);
console.log(`  fee:     ${fetched.meta?.fee} lamports`);
if (!(message instanceof MessageV1)) {
    throw new Error('the transaction just sent did not come back as a v1 message');
}
console.log(`  config:  ${json(message.transactionConfig)}`);

const roundTripped = VersionedTransaction.deserialize(transaction.serialize());
console.log('\n== decoded from the local wire bytes ==');
console.log(`  version:      ${roundTripped.version}`);
console.log(`  instructions: ${roundTripped.message.compiledInstructions.length}`);
console.log(
    `  config:       ${roundTripped.message instanceof MessageV1 ? json(roundTripped.message.transactionConfig) : 'none'}`,
);
