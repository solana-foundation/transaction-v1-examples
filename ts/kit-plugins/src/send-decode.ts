/**
 * Sends a transaction v1 transfer through a `@solana/kit` plugin client and
 * reads it back.
 *
 * Run with `just kp-send-decode`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    createClient,
    decompileTransactionMessage,
    generateKeyPairSigner,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    lamports,
    type ReadonlyUint8Array,
    type TransactionVersion,
    type V1TransactionConfig,
} from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';

const RPC_URL = process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899';
const RPC_SUBSCRIPTIONS_URL = process.env.TXV1_RPC_SUBSCRIPTIONS_URL ?? 'ws://127.0.0.1:8900';

const json = (value: unknown) => JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry));

function decodeVersionAndConfig(wireTransaction: ReadonlyUint8Array): {
    config?: V1TransactionConfig;
    version: TransactionVersion;
} {
    const { messageBytes } = getTransactionDecoder().decode(wireTransaction);
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(messageBytes));
    return 'config' in message && message.config !== undefined
        ? { config: message.config, version: message.version }
        : { version: message.version };
}

const client = await createClient()
    .use(generatedSigner())
    .use(
        solanaLocalRpc({
            rpcSubscriptionsUrl: RPC_SUBSCRIPTIONS_URL,
            rpcUrl: RPC_URL,
            transactionConfig: { priorityFeeLamports: lamports(5_000n), version: 1 },
        }),
    )
    .use(airdropSigner(lamports(1_000_000_000n)));

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

const remote = decodeVersionAndConfig(getBase64Encoder().encode(fetched.transaction[0]));
console.log('\n== decoded from the base64 wire bytes ==');
console.log(`  version: ${remote.version} (${fetched.version} in the response envelope)`);
console.log(`  config:  ${json(remote.config)}`);
