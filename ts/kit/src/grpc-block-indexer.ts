/**
 * Indexes whole blocks off a Yellowstone gRPC stream, tallying versions.
 *
 * Unlike `getBlock` there is no ceiling to opt into and no error when v1
 * appears: the block arrives, and an unprepared consumer counts v1 as v0.
 *
 * Run with `just ts-grpc-block-indexer`.
 */

import { getBase58Decoder } from '@solana/kit';

import { computeBudgetOfMessage, formatComputeBudget } from './lib/budget';
import {
    ALL_BLOCKS_REQUEST,
    DEFAULT_GRPC_ENDPOINT,
    exitOnStreamClose,
    messageVersion,
    readEnvLimit,
    subscribe,
    type SubscribeUpdate,
} from './lib/grpc';

const base58 = getBase58Decoder();

const exitAfterV1Blocks = readEnvLimit('TXV1_EXIT_AFTER_V1_BLOCKS');
const { close, stream } = await subscribe(DEFAULT_GRPC_ENDPOINT, ALL_BLOCKS_REQUEST);
let blocksWithV1 = 0;

console.log(`subscribed to ${DEFAULT_GRPC_ENDPOINT}`);

stream.on('data', (update: SubscribeUpdate) => {
    const block = update.block;
    if (!block) {
        return;
    }

    const tally = { legacy: 0, v0: 0, v1: 0 };
    const v1Transactions: { config: string; signature: string }[] = [];
    let priorityFeeLamports = 0n;

    for (const transaction of block.transactions) {
        const message = transaction.transaction?.message;
        if (!message) {
            continue;
        }
        const version = messageVersion(message);
        tally[version] += 1;
        const budget = computeBudgetOfMessage(message);
        priorityFeeLamports += budget.priorityFeeLamports ?? 0n;
        if (version === 'v1') {
            v1Transactions.push({
                config: formatComputeBudget(budget, '    '),
                signature: base58.decode(transaction.signature),
            });
        }
    }

    console.log(
        `slot ${block.slot} (${block.executedTransactionCount} txs): ` +
            `legacy=${tally.legacy} v0=${tally.v0} v1=${tally.v1} ` +
            `priorityFees=${priorityFeeLamports} lamports`,
    );
    for (const { config, signature } of v1Transactions) {
        console.log(`  v1 ${signature}`);
        console.log(config);
    }

    if (v1Transactions.length > 0) {
        blocksWithV1 += 1;
        if (exitAfterV1Blocks > 0 && blocksWithV1 >= exitAfterV1Blocks) {
            console.log('\nreached the v1 block limit, exiting');
            close();
            process.exit(0);
        }
    }
});

exitOnStreamClose(stream, close);
