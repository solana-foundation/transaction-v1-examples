/**
 * Sends a transaction v1 transfer through a `@solana/kit` plugin client and
 * reads it back.
 *
 * Run with `just kp-send-decode`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import { generateKeyPairSigner, lamports } from '@solana/kit';

import { createV1Client } from './lib/client';
import { decodeBase64Transaction, json } from './lib/v1';

const client = await createV1Client(1_000_000_000n);

const recipient = await generateKeyPairSigner();
const instruction = getTransferSolInstruction({
    amount: lamports(10_000_000n),
    destination: recipient.address,
    source: client.payer,
});

const planned = await client.planTransaction([instruction]);
console.log('== planned ==');
console.log(`  version: ${planned.version}`);
console.log(`  config:  ${'config' in planned ? json(planned.config) : 'none'}`);

const { context } = await client.sendTransaction([instruction]);
console.log(`\n== sent ==\n  signature: ${context.signature}`);

console.log('\n== getTransaction without maxSupportedTransactionVersion ==');
try {
    await client.rpc.getTransaction(context.signature, { commitment: 'confirmed', encoding: 'base64' }).send();
    console.log('  unexpectedly succeeded');
} catch (error) {
    console.log(`  rejected: ${error instanceof Error ? error.message : String(error)}`);
}

const fetched = await client.rpc
    .getTransaction(context.signature, {
        commitment: 'confirmed',
        encoding: 'base64',
        maxSupportedTransactionVersion: 1,
    })
    .send();
if (fetched === null) {
    throw new Error('the transaction just sent was not found');
}

const remote = decodeBase64Transaction(fetched.transaction[0]);
console.log('\n== decoded from the base64 wire bytes ==');
console.log(`  version: ${remote.version} (${fetched.version} in the response envelope)`);
console.log(`  config:  ${json(remote.config)}`);
