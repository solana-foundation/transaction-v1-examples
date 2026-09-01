/**
 * Decoded-gRPC fixtures shared by the offline tests.
 *
 * The generated `Message` type requires fields no version test varies — a
 * header, a blockhash, a lookup table list — so a fixture cannot simply omit
 * the parts of a transaction the code under test never reads.
 */

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { getAddressEncoder, type Instruction, type InstructionWithData, type ReadonlyUint8Array } from '@solana/kit';

import type { GrpcCompiledInstruction, GrpcMessage } from '../src/lib/grpc';

/** The ComputeBudget program's address as it appears in a compiled account key list. */
export const COMPUTE_BUDGET_KEY = new Uint8Array(getAddressEncoder().encode(COMPUTE_BUDGET_PROGRAM_ADDRESS));

/** A minimal decoded message, with every field the caller cares about overridable. */
export function grpcMessage(overrides: Partial<GrpcMessage>): GrpcMessage {
    return {
        accountKeys: [],
        addressTableLookups: [],
        header: { numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0, numRequiredSignatures: 1 },
        instructions: [],
        recentBlockhash: new Uint8Array(32),
        versioned: false,
        ...overrides,
    };
}

/** A legacy or v0 message whose only account key is the ComputeBudget program. */
export function computeBudgetMessage(instructions: GrpcCompiledInstruction[], versioned = true): GrpcMessage {
    return grpcMessage({ accountKeys: [COMPUTE_BUDGET_KEY], instructions, versioned });
}

/**
 * Compiles a real ComputeBudget instruction into the shape gRPC delivers.
 *
 * The instruction data comes from the generated client, so the fixtures encode
 * exactly what a validator would put on the wire rather than a hand-written
 * discriminator and little-endian operand.
 */
export function compileInstruction(
    instruction: Instruction & InstructionWithData<ReadonlyUint8Array>,
): GrpcCompiledInstruction {
    return { accounts: new Uint8Array(), data: new Uint8Array(instruction.data), programIdIndex: 0 };
}
