/**
 * Offline tests: the TypeScript helpers that stand in for missing client
 * functions, against what the Anza client crates produce for the same inputs.
 * `rust/tests/wire.rs` asserts the same expected values on the Rust side.
 */

import { findProgrammaticSignerPda } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    type Address,
    createKeyPairFromPrivateKeyBytes,
    createNoopSigner,
    getAddressFromPublicKey,
    getBase64Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    type ReadonlyUint8Array,
    singleInstructionPlan,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { authorizationMessage, executionMessage } from '../src/lib/signer';
import { nextNonce } from '../src/lib/spl-nonce';

// Fixed inputs: the authority's secret key is 32 bytes of 7, and each address
// is 32 bytes of the number in its comment.
const AUTHORITY_SEED = new Uint8Array(32).fill(7);
const RECIPIENT = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR' as Address; // 2
const NONCE_ACCOUNT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8' as Address; // 3
const NONCE = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq' as Address; // 4
const AMOUNT = 10_000_000n;

// What the Anza client crates produce for them.
const EXPECTED_EXECUTION_MESSAGE =
    'gQEAAQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAEDuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3YCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIMAAABAgAAAICWmAAAAAAA';
const EXPECTED_AUTHORIZATION_MESSAGE =
    'gQEABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEI6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLPaWlfj5JYuK1SNOpr++SvWDuDtHoo2hDLZ0DIYFQcOAWWGT5rG9fLwDcrw+nggq710Pl+QXhA8DKWM9aBvVZsy/dBGfmAqhXLmy1s8ZgUf7C7Mf6E2VM3yGC6u0UgpYcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQHnQACAQUGAgMHAIEBAAEAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQBA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICDAAAAQIAAACAlpgAAAAAAA==';
const EXPECTED_NEXT_NONCE = 'SewSJdKpN41PPGEVRoSTvX6kEW2JSGoZbd9iPxtzf94';

async function fixture() {
    const keyPair = await createKeyPairFromPrivateKeyBytes(AUTHORITY_SEED);
    const authority = await getAddressFromPublicKey(keyPair.publicKey);
    const [pda] = await findProgrammaticSignerPda({ authority });
    const transfer = getTransferSolInstruction({
        amount: AMOUNT,
        destination: RECIPIENT,
        source: createNoopSigner(pda),
    });
    const execution = executionMessage(pda, singleInstructionPlan(transfer), NONCE);
    const authorization = authorizationMessage(execution, NONCE_ACCOUNT, pda, authority);
    return { authorization, execution };
}

/**
 * The instructions a compiled message carries, independent of how its
 * accounts were ordered: program, data, and each account's address and role.
 * Kit and the Rust compiler order accounts differently, so the authorization
 * messages hold the same instruction but not the same bytes. See the README.
 */
function instructionsOf(message: ReadonlyUint8Array) {
    const decoded = getCompiledTransactionMessageDecoder().decode(message);
    if (decoded.version !== 1) throw new Error('expected a v1 message');
    const { header, staticAccounts } = decoded;
    const roleOf = (index: number) => {
        const isSigner = index < header.numSignerAccounts;
        const isWritable = isSigner
            ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
            : index < staticAccounts.length - header.numReadonlyNonSignerAccounts;
        return `${isSigner ? 'signer' : 'unsigned'} ${isWritable ? 'writable' : 'readonly'}`;
    };
    return decoded.instructionHeaders.map((instructionHeader, i) => ({
        accounts: decoded.instructionPayloads[i]!.instructionAccountIndices.map(index => ({
            address: staticAccounts[index],
            role: roleOf(index),
        })),
        data: getBase64Decoder().decode(decoded.instructionPayloads[i]!.instructionData),
        programAddress: staticAccounts[instructionHeader.programAccountIndex],
    }));
}

describe('against the Anza client crates', () => {
    it('the execution message matches byte for byte', async () => {
        const { execution } = await fixture();
        expect(getBase64Decoder().decode(execution)).toBe(EXPECTED_EXECUTION_MESSAGE);
    });

    it('the authorization message holds the same Execute instruction', async () => {
        const { authorization } = await fixture();
        const theirs = getBase64Encoder().encode(EXPECTED_AUTHORIZATION_MESSAGE);
        expect(instructionsOf(authorization)).toEqual(instructionsOf(theirs));
        expect(authorization.length).toBe(theirs.length);
    });

    it('the next nonce matches', async () => {
        const { execution } = await fixture();
        expect(await nextNonce(NONCE_ACCOUNT, NONCE, execution)).toBe(EXPECTED_NEXT_NONCE);
    });
});
