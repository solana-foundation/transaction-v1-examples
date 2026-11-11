/**
 * Tests that run against a live validator.
 *
 * Skipped unless `PSIGNER_LIVE=1`, which `just test-live` sets after starting
 * a validator with the three programs loaded.
 */

import {
    ED25519_SIGNER_ERROR__INVALID_SIGNATURE,
    MESSAGE_EXECUTOR_ERROR__NONCE_MISMATCH,
} from '@solana-program/ed25519-programmatic-signer';
import {
    generateKeyPairSigner,
    isSolanaError,
    lamports,
    type ReadonlyUint8Array,
    type SignatureBytes,
    SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    unwrapSimulationError,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { assertProgramsDeployed, createFundedClient } from '../src/lib/cluster';
import {
    authorizationMessage,
    executionMessage,
    programmaticSignerAddress,
    signAuthorization,
} from '../src/lib/signer';
import { createNonceAccount, nextNonce } from '../src/lib/spl-nonce';
import { associatedTokenAddress, createMint, fetchBalance, mintToAta } from '../src/lib/token';
import { solTransfer, tokenTransfer } from './fixtures';

const live = process.env.PSIGNER_LIVE === '1';

/**
 * A funded relayer, a cold authority, its PDA holding 0.1 SOL, and a nonce
 * account the PDA controls.
 */
async function setup() {
    const relayer = await createFundedClient(5_000_000_000n);
    const authority = await generateKeyPairSigner();
    const pda = await programmaticSignerAddress(authority.address);
    await relayer.system.instructions
        .transferSol({ amount: lamports(100_000_000n), destination: pda, source: relayer.payer })
        .sendTransaction();
    const nonceAccount = await createNonceAccount(relayer, pda);
    const nonce = async () => (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data.nonce;
    /** Relays a signed authorization from the hot key. */
    const relay = (authorization: ReadonlyUint8Array, signature: SignatureBytes) =>
        relayer.ed25519Signer.instructions
            .submit({ message: authorization, signatures: [signature] })
            .sendTransaction();
    return { authority, nonce, nonceAccount, pda, relay, relayer };
}

/**
 * Asserts a relay is rejected with the custom program error `code`. The
 * client simulates before sending, so the rejection arrives wrapped in a
 * simulation error.
 */
async function expectCustomError(promise: Promise<unknown>, code: number) {
    try {
        await promise;
    } catch (error) {
        expect(isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)).toBe(true);
        if (!isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)) throw error;
        const cause = unwrapSimulationError(error.cause);
        expect(isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)).toBe(true);
        if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) throw error;
        expect(cause.context.code).toBe(code);
        return;
    }
    throw new Error('expected the transaction to be rejected');
}

describe.skipIf(!live)('sign-relay', () => {
    it('the programs are deployed', async () => {
        await assertProgramsDeployed((await createFundedClient(1_000_000_000n)).rpc);
    });

    it('a cold-signed transfer relays once and advances the nonce as predicted', async () => {
        const { authority, nonceAccount, pda, relay, relayer } = await setup();
        const recipient = (await generateKeyPairSigner()).address;
        const { nonce, authority: nonceAuthority } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
        expect(nonceAuthority).toBe(pda);

        const execution = executionMessage(pda, solTransfer(pda, recipient, 1_000_000n), nonce);
        const authorization = authorizationMessage(execution, nonceAccount, pda, authority.address);
        const signature = await signAuthorization(authorization, authority);
        const predicted = await nextNonce(nonceAccount, nonce, execution);

        await relay(authorization, signature);
        expect((await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(1_000_000n);
        expect((await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data.nonce).toBe(predicted);

        await expectCustomError(relay(authorization, signature), MESSAGE_EXECUTOR_ERROR__NONCE_MISMATCH);
        expect((await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(1_000_000n);
    });

    it('a tampered authorization is rejected', async () => {
        const { authority, nonce, nonceAccount, pda, relay, relayer } = await setup();
        const recipient = (await generateKeyPairSigner()).address;

        // Sign one amount, relay another.
        const signed = executionMessage(pda, solTransfer(pda, recipient, 1_000_000n), await nonce());
        const signature = await signAuthorization(
            authorizationMessage(signed, nonceAccount, pda, authority.address),
            authority,
        );
        const edited = executionMessage(pda, solTransfer(pda, recipient, 2_000_000n), await nonce());
        const authorization = authorizationMessage(edited, nonceAccount, pda, authority.address);
        await expectCustomError(relay(authorization, signature), ED25519_SIGNER_ERROR__INVALID_SIGNATURE);
        expect((await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(0n);
    });
});

describe.skipIf(!live)('token-transfer', () => {
    it('a cold-signed token withdrawal creates the destination and lands', async () => {
        const { authority, nonce, nonceAccount, pda, relay, relayer } = await setup();
        const recipient = (await generateKeyPairSigner()).address;
        const mint = await createMint(relayer);
        const pdaAccount = await mintToAta(relayer, mint, pda, 1_000_000_000n);
        const initial = await nonce();

        const execution = executionMessage(pda, await tokenTransfer(mint, pda, recipient, 250_000_000n), initial);
        const authorization = authorizationMessage(execution, nonceAccount, pda, authority.address);
        const signature = await signAuthorization(authorization, authority);
        const predicted = await nextNonce(nonceAccount, initial, execution);

        await relay(authorization, signature);
        expect(await fetchBalance(relayer, await associatedTokenAddress(recipient, mint))).toBe(250_000_000n);
        expect(await fetchBalance(relayer, pdaAccount)).toBe(750_000_000n);
        expect(await nonce()).toBe(predicted);
        await expectCustomError(relay(authorization, signature), MESSAGE_EXECUTOR_ERROR__NONCE_MISMATCH);
    });
});
