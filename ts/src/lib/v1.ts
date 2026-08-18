/** Shared pieces for the transaction v1 (SIMD-0385) examples. */

import {
    decompileTransactionMessage,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type ReadonlyUint8Array,
    type TransactionMessage,
    type TransactionVersion,
    type V1TransactionConfig,
} from '@solana/kit';

/**
 * A transaction message pinned to version 1.
 *
 * Kit keeps its `V1TransactionMessage` type internal, so the v1 arm is pulled
 * out of the exported `TransactionMessage` union instead.
 */
export type V1TransactionMessage = Extract<TransactionMessage, { version: 1 }>;

/**
 * The compute budget the examples send, with every field set.
 *
 * The heap size is deliberately not 32 KB, which is what an *unset* heap
 * resolves to and so would be indistinguishable from omitting the field.
 */
export const EXAMPLE_CONFIG = {
    computeUnitLimit: 20_000,
    heapSize: 64 * 1024,
    loadedAccountsDataSizeLimit: 64 * 1024,
    priorityFeeLamports: 5_000n,
} as const satisfies Required<V1TransactionConfig>;

/**
 * Reads the version and config out of a serialized transaction.
 *
 * A compiled message stores the config as a bitmask plus a positional list, so
 * it is decompiled to address the four fields by name. Decompiling fetches no
 * accounts here, because v1 cannot use address lookup tables.
 *
 * @param wireTransaction - The signed transaction exactly as it goes on the wire.
 */
export function decodeTransactionVersion(wireTransaction: ReadonlyUint8Array): {
    config?: V1TransactionConfig;
    version: TransactionVersion;
} {
    const transaction = getTransactionDecoder().decode(wireTransaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const message = decompileTransactionMessage(compiled);
    return 'config' in message && message.config !== undefined
        ? { config: message.config, version: message.version }
        : { version: message.version };
}
