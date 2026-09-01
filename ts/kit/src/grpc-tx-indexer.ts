/**
 * Indexes transactions off a Yellowstone gRPC stream, isolating v1.
 *
 * `SubscribeRequestFilterTransactions` has no version field, so a consumer
 * subscribes to everything and discriminates client-side.
 *
 * Run with `just ts-grpc-tx-indexer`.
 */

import { getBase58Decoder, getBlockhashDecoder } from '@solana/kit';

import { computeBudgetOfMessage, formatComputeBudget } from './lib/budget';
import {
    ALL_TRANSACTIONS_REQUEST,
    DEFAULT_GRPC_ENDPOINT,
    exitOnStreamClose,
    messageVersion,
    readEnvLimit,
    subscribe,
    type SubscribeUpdate,
} from './lib/grpc';

const base58 = getBase58Decoder();
const blockhash = getBlockhashDecoder();

const exitAfterV1 = readEnvLimit('TXV1_EXIT_AFTER_V1');
const { close, stream } = await subscribe(DEFAULT_GRPC_ENDPOINT, ALL_TRANSACTIONS_REQUEST);
const tally = { legacy: 0, v0: 0, v1: 0 };

console.log(`subscribed to ${DEFAULT_GRPC_ENDPOINT}`);

stream.on('data', (update: SubscribeUpdate) => {
    const message = update.transaction?.transaction?.transaction?.message;
    if (!message) {
        return;
    }

    const version = messageVersion(message);
    tally[version] += 1;

    // This is the line an existing indexer has to change: scanning
    // ComputeBudget instructions alone returns nothing for v1 without erroring.
    const budget = computeBudgetOfMessage(message);
    const signature = base58.decode(update.transaction!.transaction!.signature);
    console.log(
        `slot ${update.transaction!.slot} ${version} ` +
            `cuLimit=${budget.computeUnitLimit ?? '-'} ` +
            `priorityFee=${budget.priorityFeeLamports ?? '-'} lamports sig ${signature}`,
    );

    if (version !== 'v1') {
        return;
    }

    console.log(formatComputeBudget(budget));
    // On v1 the wire's `recentBlockhash` slot carries the lifetime specifier.
    console.log(`  lifetimeSpecifier:            ${blockhash.decode(message.recentBlockhash)}`);
    console.log(`  addressTableLookups:          ${message.addressTableLookups.length} (v1 never has any)`);
    console.log(`  running tally:                legacy=${tally.legacy} v0=${tally.v0} v1=${tally.v1}`);

    if (exitAfterV1 > 0 && tally.v1 >= exitAfterV1) {
        console.log('\nreached the v1 limit, exiting');
        close();
        process.exit(0);
    }
});

exitOnStreamClose(stream, close);
