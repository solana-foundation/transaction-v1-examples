/** Endpoints and display helpers for the JSON-RPC examples. */

import type { V1TransactionConfig } from '@solana/kit';

import { formatComputeBudget } from './budget';

/**
 * Formats the config decoded out of a transaction's wire bytes.
 *
 * A legacy or v0 transaction carries no config at all, which is a different
 * thing from a v1 config whose fields are unset, so the two print differently.
 */
export function formatTransactionConfig(config: V1TransactionConfig | undefined, indent = '  '): string {
    if (config === undefined) {
        return `${indent}no config: not a v1 transaction`;
    }
    return formatComputeBudget(config, indent);
}

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
export const DEFAULT_RPC_SUBSCRIPTIONS_URL = 'ws://127.0.0.1:8900';

/** Serializes a value that may contain a bigint priority fee. */
export const json = (value: unknown) =>
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry));

/**
 * The `getBlock` request options the examples hold constant.
 *
 * `maxSupportedTransactionVersion` is deliberately absent — it is the field the
 * examples vary, and omitting it caps the request at legacy.
 */
export const BLOCK_CONFIG = {
    commitment: 'confirmed',
    encoding: 'base64',
    rewards: false,
    transactionDetails: 'full',
} as const;
