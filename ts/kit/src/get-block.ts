/**
 * Reads a block containing v1 transactions over JSON-RPC.
 *
 * When `maxSupportedTransactionVersion` is below the highest version in the
 * block, the entire request fails — a caller pinned at 0 loses whole blocks.
 *
 * Run with `just ts-get-block`.
 */

import { BLOCK_CONFIG, formatTransactionConfig } from './lib/rpc';
import { createClients, sendV1TransferAndGetSlot } from './lib/send';
import { decodeBase64Transaction } from './lib/v1';

const clients = createClients();
const slotArgument = process.argv[2];
const slot = slotArgument === undefined ? (await sendV1TransferAndGetSlot(clients)).slot : BigInt(slotArgument);
console.log(`reading slot ${slot}\n`);

const describeRejection = (error: unknown) => `  rejected: ${error instanceof Error ? error.message : String(error)}`;

console.log('== maxSupportedTransactionVersion omitted ==');
try {
    await clients.rpc.getBlock(slot, BLOCK_CONFIG).send();
    console.log('  succeeded: this block holds no versioned transactions');
} catch (error) {
    console.log(describeRejection(error));
}

console.log('\n== maxSupportedTransactionVersion 0 ==');
try {
    await clients.rpc.getBlock(slot, { ...BLOCK_CONFIG, maxSupportedTransactionVersion: 0 }).send();
    console.log('  succeeded: this block holds no v1 transactions');
} catch (error) {
    console.log(describeRejection(error));
}

console.log('\n== maxSupportedTransactionVersion 1 ==');
const block = await clients.rpc.getBlock(slot, { ...BLOCK_CONFIG, maxSupportedTransactionVersion: 1 }).send();
if (block === null || !('transactions' in block)) {
    throw new Error(`slot ${slot} has no transaction details`);
}

const tally = { legacy: 0, v0: 0, v1: 0 };
for (const transaction of block.transactions) {
    // Unlike gRPC, JSON-RPC reports the version — but only because the request
    // opted in.
    if (transaction.version === 1) {
        tally.v1 += 1;
    } else if (transaction.version === 0) {
        tally.v0 += 1;
    } else {
        tally.legacy += 1;
    }
}
console.log(`  legacy=${tally.legacy} v0=${tally.v0} v1=${tally.v1} of ${block.transactions.length} transactions`);

for (const transaction of block.transactions) {
    if (transaction.version !== 1) {
        continue;
    }
    const decoded = decodeBase64Transaction(transaction.transaction[0]);
    console.log(`  v1 ${decoded.signature}`);
    console.log(formatTransactionConfig(decoded.config, '    '));
}
