/**
 * Offline tests: the PDA, the nonce successor, the two signed messages, and
 * the token withdrawal, against the fixtures `rust/tests/wire.rs` froze from
 * the Anza client crate.
 */

import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    getBase64Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    type ReadonlyUint8Array,
    verifySignature,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { MESSAGE_EXECUTOR_PROGRAM_ADDRESS } from '../src/client';
import { nextNonce } from '../src/lib/nonce';
import { authorizationMessage, executionMessage, programmaticSigner, transferFromPda } from '../src/lib/signer';
import { associatedTokenAddress, withdraw } from '../src/lib/token';
import {
    AMOUNT,
    authorityKeyPair,
    EXPECTED_AUTHORITY,
    EXPECTED_AUTHORIZATION_MESSAGE,
    EXPECTED_EXECUTION_MESSAGE,
    EXPECTED_NEXT_NONCE,
    EXPECTED_PDA,
    EXPECTED_TOKEN_EXECUTION_MESSAGE,
    MINT,
    NONCE,
    NONCE_ACCOUNT,
    RECIPIENT,
} from './fixtures';

const base64 = getBase64Decoder();

async function fixture() {
    const authority = await authorityKeyPair();
    const pda = await programmaticSigner(authority.address);
    const execution = executionMessage(pda, [transferFromPda(pda, RECIPIENT, AMOUNT)], NONCE);
    const authorization = authorizationMessage(execution, NONCE_ACCOUNT, pda, authority.address);
    return { authority, authorization, execution, pda };
}

describe('the programmatic signer PDA', () => {
    it('is derived the way the Rust client derives it', async () => {
        const { authority, pda } = await fixture();
        expect(authority.address).toBe(EXPECTED_AUTHORITY);
        expect(pda).toBe(EXPECTED_PDA);
    });
});

describe('the execution message', () => {
    it('matches the Rust client byte for byte', async () => {
        const { execution } = await fixture();
        expect(base64.decode(execution)).toBe(EXPECTED_EXECUTION_MESSAGE);
    });

    it('is v1, paid and signed by the PDA, with the nonce as its lifetime and no config', async () => {
        const { execution, pda } = await fixture();
        const decoded = getCompiledTransactionMessageDecoder().decode(execution);
        expect(decoded.version).toBe(1);
        if (decoded.version !== 1) throw new Error('unreachable');
        expect(decoded.lifetimeToken).toBe(NONCE);
        expect(decoded.configMask).toBe(0);
        expect(decoded.staticAccounts[0]).toBe(pda);
        expect(decoded.header.numSignerAccounts).toBe(1);
        expect(decoded.numInstructions).toBe(1);
    });
});

describe('the authorization message', () => {
    it('holds the same Execute instruction as the Rust client, whatever the account order', async () => {
        const { authorization } = await fixture();
        const theirs = getBase64Encoder().encode(EXPECTED_AUTHORIZATION_MESSAGE);
        expect(instructionsOf(authorization)).toEqual(instructionsOf(theirs));
        expect(authorization.length).toBe(theirs.length);
    });

    it('wraps one Execute instruction and is signed by the authority only', async () => {
        const { authority, authorization, execution, pda } = await fixture();
        const decoded = getCompiledTransactionMessageDecoder().decode(authorization);
        expect(decoded.version).toBe(1);
        if (decoded.version !== 1) throw new Error('unreachable');
        const signers = decoded.staticAccounts.slice(0, decoded.header.numSignerAccounts);
        expect(signers).toEqual([authority.address]);
        expect(signers).not.toContain(pda);
        expect(decoded.lifetimeToken).toBe('11111111111111111111111111111111');
        expect(decoded.configMask).toBe(0);
        expect(decoded.numInstructions).toBe(1);
        expect(decoded.staticAccounts[decoded.instructionHeaders[0]!.programAccountIndex]).toBe(
            MESSAGE_EXECUTOR_PROGRAM_ADDRESS,
        );
        // The execution message travels inside the instruction data, after the tag.
        const data = decoded.instructionPayloads[0]!.instructionData;
        expect(base64.decode(data.slice(data.length - execution.length))).toBe(base64.decode(execution));
    });

    it('is what the signature covers', async () => {
        const { authority, authorization } = await fixture();
        const { signBytes } = await import('@solana/kit');
        const signature = await signBytes(authority.keyPair.privateKey, authorization);
        expect(await verifySignature(authority.keyPair.publicKey, signature, authorization)).toBe(true);
        const tampered = new Uint8Array(authorization);
        tampered[tampered.length - 1]! ^= 1;
        expect(await verifySignature(authority.keyPair.publicKey, signature, tampered)).toBe(false);
    });
});

describe('the next nonce', () => {
    it('is predictable from the execution message, and matches the Rust client', async () => {
        const { execution, pda } = await fixture();
        expect(await nextNonce(NONCE_ACCOUNT, NONCE, execution)).toBe(EXPECTED_NEXT_NONCE);
        const other = executionMessage(pda, [transferFromPda(pda, RECIPIENT, AMOUNT + 1n)], NONCE);
        expect(await nextNonce(NONCE_ACCOUNT, NONCE, other)).not.toBe(EXPECTED_NEXT_NONCE);
    });
});

/**
 * The instructions a compiled message carries, independent of how its
 * accounts were ordered: program, data, and each account's address and role.
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
        data: base64.decode(decoded.instructionPayloads[i]!.instructionData),
        programAddress: staticAccounts[instructionHeader.programAccountIndex],
    }));
}

describe('a token withdrawal', () => {
    it('holds the same instructions as the Rust client, whatever the account order', async () => {
        const { pda } = await fixture();
        const ours = executionMessage(pda, await withdraw(MINT, pda, RECIPIENT, AMOUNT), NONCE);
        const theirs = getBase64Encoder().encode(EXPECTED_TOKEN_EXECUTION_MESSAGE);
        expect(instructionsOf(ours)).toEqual(instructionsOf(theirs));
        expect(ours.length).toBe(theirs.length);
    });

    it('creates the destination and transfers as the PDA, the only signer', async () => {
        const { pda } = await fixture();
        const message = executionMessage(pda, await withdraw(MINT, pda, RECIPIENT, AMOUNT), NONCE);
        const [create, transfer] = instructionsOf(message);
        expect(create!.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
        expect(create!.accounts[0]).toEqual({ address: pda, role: 'signer writable' });
        expect(transfer!.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
        expect(transfer!.accounts[0]!.address).toBe(await associatedTokenAddress(pda, MINT));
        expect(transfer!.accounts[2]!.address).toBe(await associatedTokenAddress(RECIPIENT, MINT));
        expect(transfer!.accounts[3]).toEqual({ address: pda, role: 'signer writable' });
        const decoded = getCompiledTransactionMessageDecoder().decode(message);
        expect(decoded.header.numSignerAccounts).toBe(1);
        expect(decoded.staticAccounts[0]).toBe(pda);
    });
});
