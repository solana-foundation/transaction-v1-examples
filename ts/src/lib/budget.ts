/**
 * Reading a transaction's compute budget regardless of its version.
 *
 * Legacy and v0 state their budget in ComputeBudget program instructions, v1
 * in the message config. `computeBudgetOfMessage` reads both.
 *
 * Kit's own `getTransactionMessageComputeUnitLimit` does this for messages kit
 * built itself; this module is the equivalent for one that arrived over gRPC,
 * where the instructions are still compiled.
 */

import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ComputeBudgetInstruction,
    getRequestHeapFrameInstructionDataDecoder,
    getSetComputeUnitLimitInstructionDataDecoder,
    getSetComputeUnitPriceInstructionDataDecoder,
    getSetLoadedAccountsDataSizeLimitInstructionDataDecoder,
    identifyComputeBudgetInstruction,
    MAX_COMPUTE_UNIT_LIMIT,
} from '@solana-program/compute-budget';
import { getAddressDecoder, type V1TransactionConfig } from '@solana/kit';

import { type GrpcMessage, messageVersion } from './grpc';

/** Compute units granted per instruction when a legacy or v0 transaction sets no limit. */
export const DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION = 200_000;

/**
 * A transaction's compute budget, normalised across all three versions.
 *
 * v1's four config fields are the normalisation target. Only
 * `priorityFeeLamports` needs converting: legacy and v0 state a price in
 * micro-lamports per compute unit rather than a total in lamports.
 */
export type ComputeBudget = V1TransactionConfig;

const addressDecoder = getAddressDecoder();

/**
 * Whether a compiled instruction's program account key is the ComputeBudget program.
 *
 * gRPC delivers account keys as raw protobuf `bytes`, so they are decoded to
 * base58 before comparison; any other length cannot be an address.
 */
function isComputeBudgetProgram(accountKey: Uint8Array | undefined): boolean {
    return accountKey?.length === 32 && addressDecoder.decode(accountKey) === COMPUTE_BUDGET_PROGRAM_ADDRESS;
}

/**
 * Renders a budget for display, spelling out what each absent field means.
 *
 * The annotations describe v1's rules: an absent limit resolves to zero, and
 * only `heapSize` falls back to 32 KB. On legacy and v0 an absent compute unit
 * limit resolves to {@link defaultComputeUnitLimit} instead.
 */
export function formatComputeBudget(budget: ComputeBudget, indent = '  '): string {
    const priorityFee =
        budget.priorityFeeLamports === undefined
            ? 'unset (0)'
            : `${budget.priorityFeeLamports} lamports (total, not micro-lamports/CU)`;
    return [
        `${indent}priorityFee:                  ${priorityFee}`,
        `${indent}computeUnitLimit:             ${budget.computeUnitLimit ?? 'unset (0)'}`,
        `${indent}loadedAccountsDataSizeLimit:  ${budget.loadedAccountsDataSizeLimit ?? 'unset (0)'}`,
        `${indent}heapSize:                     ${budget.heapSize ?? 'unset (32KB default)'}`,
    ].join('\n');
}

/** The compute unit limit a legacy or v0 transaction gets when it sets none. */
export function defaultComputeUnitLimit(instructionCount: number): number {
    return Math.min(DEFAULT_COMPUTE_UNITS_PER_INSTRUCTION * instructionCount, MAX_COMPUTE_UNIT_LIMIT);
}

/**
 * Reads the compute budget out of a message received over gRPC.
 *
 * @param message - A transaction message of any version.
 */
export function computeBudgetOfMessage(message: GrpcMessage): ComputeBudget {
    if (messageVersion(message) === 'v1') {
        const config = message.config ?? {};
        return {
            computeUnitLimit: config.computeUnitLimit,
            heapSize: config.heapSize,
            loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
            priorityFeeLamports: config.priorityFee === undefined ? undefined : BigInt(config.priorityFee),
        };
    }

    const budget: ComputeBudget = {};
    let priceMicroLamportsPerCu: bigint | undefined;

    for (const instruction of message.instructions) {
        if (!isComputeBudgetProgram(message.accountKeys[instruction.programIdIndex])) {
            continue;
        }
        const data = instruction.data;
        switch (identifyComputeBudgetInstruction(data)) {
            case ComputeBudgetInstruction.RequestHeapFrame:
                budget.heapSize = getRequestHeapFrameInstructionDataDecoder().decode(data).bytes;
                break;
            case ComputeBudgetInstruction.SetComputeUnitLimit:
                budget.computeUnitLimit = getSetComputeUnitLimitInstructionDataDecoder().decode(data).units;
                break;
            case ComputeBudgetInstruction.SetComputeUnitPrice:
                priceMicroLamportsPerCu = getSetComputeUnitPriceInstructionDataDecoder().decode(data).microLamports;
                break;
            case ComputeBudgetInstruction.SetLoadedAccountsDataSizeLimit:
                budget.loadedAccountsDataSizeLimit =
                    getSetLoadedAccountsDataSizeLimitInstructionDataDecoder().decode(data).accountDataSizeLimit;
                break;
            default:
                break;
        }
    }

    if (priceMicroLamportsPerCu !== undefined) {
        const limit = BigInt(budget.computeUnitLimit ?? defaultComputeUnitLimit(message.instructions.length));
        // The runtime rounds the total up to whole lamports.
        const microLamports = limit * priceMicroLamportsPerCu;
        budget.priorityFeeLamports = (microLamports + 999_999n) / 1_000_000n;
    }

    return budget;
}
