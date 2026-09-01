/** Reading the version and compute budget back out of a transaction's wire bytes. */

import {
    decompileTransactionMessage,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type TransactionVersion,
    type V1TransactionConfig,
} from '@solana/kit';

/** Serializes a value that may contain a bigint priority fee. */
export const json = (value: unknown) =>
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry));

/**
 * Reads the version and config out of a transaction the RPC returned under
 * `encoding: 'base64'`.
 *
 * A compiled message stores the config as a bitmask plus a positional list, so
 * it is decompiled to address the four fields by name. A legacy or v0
 * transaction carries no config at all, which is a different thing from a v1
 * config whose fields are unset.
 */
export function decodeBase64Transaction(encodedTransaction: string): {
    config?: V1TransactionConfig;
    version: TransactionVersion;
} {
    const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(encodedTransaction));
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(messageBytes));
    return 'config' in message && message.config !== undefined
        ? { config: message.config, version: message.version }
        : { version: message.version };
}
