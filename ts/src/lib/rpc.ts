/** Endpoints and display helpers for the JSON-RPC examples. */

import type { TransactionConfig } from '@solana/kit';

import { formatComputeBudget } from './budget';

/**
 * Formats the compute budget a `getTransaction` or `getBlock` response reports.
 *
 * The JSON-RPC projection spells an absent field as `null` where a normalised
 * budget leaves it out, so the two are bridged before formatting.
 */
export function formatTransactionConfig(config: TransactionConfig | undefined, indent = '  '): string {
    if (config === undefined) {
        return `${indent}no transactionConfig`;
    }
    return formatComputeBudget(
        {
            computeUnitLimit: config.computeUnitLimit ?? undefined,
            heapSize: config.heapSize ?? undefined,
            loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit ?? undefined,
            priorityFeeLamports: config.priorityFee ?? undefined,
        },
        indent,
    );
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
    encoding: 'json',
    rewards: false,
    transactionDetails: 'full',
} as const;
