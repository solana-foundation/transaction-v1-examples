/**
 * A Yellowstone gRPC client that can see v1 transactions.
 *
 * `@triton-one/yellowstone-grpc` generates `Message.config` (field 7) from
 * 6.0.0 on. On 5.x the field is absent from the schema, and protobuf drops
 * unknown fields, so a v1 transaction decodes as v0 with no compute budget.
 */

import Client, {
    type ClientDuplexStream,
    CommitmentLevel,
    type SubscribeRequest,
    type SubscribeUpdate,
    type SubscribeUpdateTransactionInfo,
} from '@triton-one/yellowstone-grpc';

export type { SubscribeUpdate };

/**
 * A transaction message as the generated client decodes it.
 *
 * The package exports the `SubscribeUpdate` tree but not the `solana-storage`
 * types underneath it, so `Message` is reached through the update type.
 */
export type GrpcMessage = NonNullable<NonNullable<SubscribeUpdateTransactionInfo['transaction']>['message']>;

export type GrpcCompiledInstruction = GrpcMessage['instructions'][number];

export type MessageVersion = 'legacy' | 'v0' | 'v1';

/**
 * Identifies the version of a transaction message received over gRPC.
 *
 * The wire's `versioned` boolean is true for **both** v0 and v1. The only
 * signal is the presence of `config`, which nothing but v1 sets.
 */
export function messageVersion(message: GrpcMessage): MessageVersion {
    if (message.config !== undefined) {
        return 'v1';
    }
    return message.versioned ? 'v0' : 'legacy';
}

/** The empty filter maps every `SubscribeRequest` has to carry. */
const NO_FILTERS = {
    accounts: {},
    accountsDataSlice: [],
    blocks: {},
    blocksMeta: {},
    entry: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
} as const satisfies SubscribeRequest;

/** A subscription request for every non-vote, non-failed transaction. */
export const ALL_TRANSACTIONS_REQUEST: SubscribeRequest = {
    ...NO_FILTERS,
    commitment: CommitmentLevel.CONFIRMED,
    transactions: {
        all: { accountExclude: [], accountInclude: [], accountRequired: [], failed: false, vote: false },
    },
};

/** A subscription request for every block, with its transactions included. */
export const ALL_BLOCKS_REQUEST: SubscribeRequest = {
    ...NO_FILTERS,
    blocks: { all: { accountInclude: [], includeTransactions: true } },
    commitment: CommitmentLevel.CONFIRMED,
};

/**
 * Opens a subscription to a Yellowstone gRPC endpoint.
 *
 * `subscribe()` writes the request itself, so the caller does not resend it.
 * Destroying the stream releases the channel's keepalive timers, without which
 * the process would not exit on its own.
 */
export async function subscribe(
    endpoint: string,
    request: SubscribeRequest,
): Promise<{ close: () => void; stream: ClientDuplexStream }> {
    const client = new Client(endpoint, undefined, undefined);
    await client.connect();
    const stream = await client.subscribe(request);
    return { close: () => void stream.destroy(), stream };
}

export const DEFAULT_GRPC_ENDPOINT = process.env.TXV1_GRPC_URL ?? 'http://127.0.0.1:10000';

/**
 * Reads a non-negative integer limit from the environment, rejecting a typo
 * instead of ignoring it. Unset or empty means no limit.
 */
export function readEnvLimit(name: string): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return 0;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
    }
    return value;
}

/**
 * Exits the process when the subscription ends or fails.
 *
 * A production indexer would reconnect here and resume from the last processed
 * slot.
 */
export function exitOnStreamClose(stream: ClientDuplexStream, close: () => void): void {
    stream.on('end', () => {
        console.error('stream ended');
        close();
        process.exit(1);
    });

    stream.on('error', (error: Error) => {
        console.error(error.message);
        close();
        process.exit(1);
    });
}
