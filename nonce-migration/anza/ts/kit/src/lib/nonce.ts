/**
 * Creating and reading SPL nonce accounts, and predicting their next value.
 *
 * An SPL nonce account belongs to the Nonce program, not the System program.
 * It stores a value, an authority, and the slot it was created in. The value
 * is consumed by the executor on behalf of its authority, which for these
 * examples is the programmatic signer PDA.
 */

import { getCreateAccountInstruction } from '@solana-program/system';
import {
    type Address,
    generateKeyPairSigner,
    getAddressEncoder,
    getBase58Decoder,
    getUtf8Encoder,
    type KeyPairSigner,
    type ReadonlyUint8Array,
    sequentialInstructionPlan,
} from '@solana/kit';

import { getInitializeInstruction, NONCE_PROGRAM_ADDRESS } from '../client';
import { sendTransactions } from './cluster';
import type { Clients } from './rpc';

/** The domain tag the Nonce program hashes into every successor value. */
const NONCE_STEP_TAG = 'spl-nonce::step::v1';

/** `Nonce::LEN`: a 32-byte value, a 32-byte authority, and a u64 slot. */
export const NONCE_SIZE = 72;

/**
 * Creates and initializes a nonce account for `authority`, paid for by `payer`.
 * The Anza JavaScript client has no helper for this yet; the Rust one does.
 *
 * Creation and initialization travel in one transaction so nothing can claim
 * the funded, uninitialized account in between. The authority does not sign;
 * it is only stored.
 */
export async function createNonceAccount(clients: Clients, payer: KeyPairSigner, authority: Address): Promise<Address> {
    const nonceAccount = await generateKeyPairSigner();
    const rent = await clients.rpc.getMinimumBalanceForRentExemption(BigInt(NONCE_SIZE)).send();
    await sendTransactions(
        clients,
        payer,
        sequentialInstructionPlan([
            getCreateAccountInstruction({
                lamports: rent,
                newAccount: nonceAccount,
                payer,
                programAddress: NONCE_PROGRAM_ADDRESS,
                space: BigInt(NONCE_SIZE),
            }),
            getInitializeInstruction({ authority, nonceAccount: nonceAccount.address }),
        ]),
    );
    return nonceAccount.address;
}

/**
 * The value `nonceAccount` will hold after `executionMessage` runs. The Anza
 * JavaScript client has no helper for this yet; the Rust one does.
 *
 * A System nonce advances to an unpredictable future blockhash. An SPL nonce
 * advances to a hash of its current value and the executed message, so the
 * signer knows the successor before anything is sent. That is what lets a
 * chain of actions be signed up front, each valid only after the one before.
 *
 * Mirrors `Nonce::derive_next_nonce` and `derive_transition_commitment` in the
 * Anza crates: the commitment is the SHA-256 of the execution message's wire
 * bytes, version prefix included.
 */
export async function nextNonce(
    nonceAccount: Address,
    currentNonce: Address,
    executionMessage: ReadonlyUint8Array,
): Promise<Address> {
    const addressEncoder = getAddressEncoder();
    const transitionCommitment = await sha256(executionMessage);
    const next = await sha256(
        getUtf8Encoder().encode(NONCE_STEP_TAG),
        addressEncoder.encode(NONCE_PROGRAM_ADDRESS),
        addressEncoder.encode(nonceAccount),
        addressEncoder.encode(currentNonce),
        transitionCommitment,
    );
    return getBase58Decoder().decode(next) as Address;
}

async function sha256(...parts: ReadonlyUint8Array[]): Promise<Uint8Array> {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
