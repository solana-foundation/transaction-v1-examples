/**
 * Reading a transaction's compute budget regardless of its version.
 *
 * Legacy and v0 state their budget in ComputeBudget program instructions, v1
 * in the message config. `computeBudgetOfMessage` reads both from a message
 * that arrived over gRPC, and `computeBudgetOfBase64Transaction` from a signed
 * transaction handed over as base64 — what an RPC response, a facilitator
 * request body, or a wallet's `signTransaction` output carries.
 *
 * Kit's own `getTransactionMessageComputeUnitLimit` does this for messages kit
 * built itself; this module is the equivalent for one that arrived already
 * compiled.
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
import {
    decompileTransactionMessage,
    getAddressDecoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type ReadonlyUint8Array,
    type TransactionVersion,
    type V1TransactionConfig,
} from '@solana/kit';

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

    const computeBudgetData = message.instructions
        .filter(instruction => isComputeBudgetProgram(message.accountKeys[instruction.programIdIndex]))
        .map(instruction => instruction.data);

    return computeBudgetOfInstructionData(computeBudgetData, message.instructions.length);
}

/**
 * Reads the compute budget out of a signed transaction encoded as base64.
 *
 * @param base64EncodedTransaction - A signed transaction as it goes on the wire, base64-encoded.
 */
export function computeBudgetOfBase64Transaction(base64EncodedTransaction: string): {
    budget: ComputeBudget;
    version: TransactionVersion;
} {
    const wireTransaction = getBase64Encoder().encode(base64EncodedTransaction);
    const transaction = getTransactionDecoder().decode(wireTransaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const version: TransactionVersion = compiled.version;

    switch (compiled.version) {
        case 1: {
            const { config } = decompileTransactionMessage(compiled);
            return { budget: { ...config }, version: 1 };
        }
        case 0:
        case 'legacy': {
            const computeBudgetData = compiled.instructions
                .filter(
                    instruction =>
                        compiled.staticAccounts[instruction.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS,
                )
                .map(instruction => instruction.data);
            return {
                budget: computeBudgetOfInstructionData(computeBudgetData, compiled.instructions.length),
                version: compiled.version,
            };
        }
        default: {
            throw new Error(`cannot read a compute budget from transaction version ${String(version)}`);
        }
    }
}

/**
 * Builds a budget out of the data of every ComputeBudget instruction in a
 * legacy or v0 transaction.
 * 
 * @param computeBudgetData - The data of each ComputeBudget instruction, in the order the transaction lists them.
 * @param instructionCount - How many instructions the transaction holds in total, ComputeBudget ones included.
 */
function computeBudgetOfInstructionData(
    computeBudgetData: readonly (ReadonlyUint8Array | undefined)[],
    instructionCount: number,
): ComputeBudget {
    const budget: ComputeBudget = {};
    let priceMicroLamportsPerCu: bigint | undefined;

    for (const data of computeBudgetData) {
        if (data === undefined) {
            continue;
        }
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
        const limit = BigInt(budget.computeUnitLimit ?? defaultComputeUnitLimit(instructionCount));
        // The runtime rounds the total up to whole lamports.
        const microLamports = limit * priceMicroLamportsPerCu;
        budget.priorityFeeLamports = (microLamports + 999_999n) / 1_000_000n;
    }

    return budget;
}
