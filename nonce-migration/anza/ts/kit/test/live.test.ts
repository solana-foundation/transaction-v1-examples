/**
 * Tests that run against a live validator.
 *
 * Skipped unless `PSIGNER_LIVE=1`, which `just test-live` sets after starting
 * a validator with the three programs loaded.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    generateKeyPairSigner,
    isSolanaError,
    lamports,
    singleInstructionPlan,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { fetchNonce } from '../src/client';
import { assertProgramsDeployed, fundedSigner, sendTransactions } from '../src/lib/cluster';
import { type Clients, createClients } from '../src/lib/rpc';
import {
    authorizationMessage,
    executionMessage,
    programmaticSignerAddress,
    relayTransaction,
    sendRelay,
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
async function setup(clients: Clients) {
    const relayer = await fundedSigner(clients, 5_000_000_000n);
    const authority = await generateKeyPairSigner();
    const pda = await programmaticSignerAddress(authority.address);
    await sendTransactions(
        clients,
        relayer,
        singleInstructionPlan(
            getTransferSolInstruction({ amount: lamports(100_000_000n), destination: pda, source: relayer }),
        ),
    );
    const nonceAccount = await createNonceAccount(clients, relayer, pda);
    const nonce = async () => (await fetchNonce(clients.rpc, nonceAccount, { commitment: 'confirmed' })).data.nonce;
    return { authority, nonce, nonceAccount, pda, relayer };
}

/**
 * Asserts a relay fails in preflight with `code`. Both the Executor's
 * `NonceMismatch` and the Signer's `InvalidSignature` are 3.
 */
async function expectCustomError(promise: Promise<unknown>, code: number) {
    try {
        await promise;
    } catch (error) {
        expect(isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)).toBe(
            true,
        );
        if (!isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) throw error;
        expect(isSolanaError(error.cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)).toBe(true);
        if (!isSolanaError(error.cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) throw error;
        expect(error.cause.context.code).toBe(code);
        return;
    }
    throw new Error('expected the transaction to be rejected');
}

describe.skipIf(!live)('sign-relay', () => {
    const clients = createClients();

    it('the programs are deployed', async () => {
        await assertProgramsDeployed(clients.rpc);
    });

    it('a cold-signed transfer relays once and advances the nonce as predicted', async () => {
        const { authority, nonceAccount, pda, relayer } = await setup(clients);
        const recipient = (await generateKeyPairSigner()).address;
        const { nonce, authority: nonceAuthority } = (
            await fetchNonce(clients.rpc, nonceAccount, { commitment: 'confirmed' })
        ).data;
        expect(nonceAuthority).toBe(pda);

        const execution = executionMessage(pda, solTransfer(pda, recipient, 1_000_000n), nonce);
        const authorization = authorizationMessage(execution, nonceAccount, pda, authority.address);
        const signature = await signAuthorization(authorization, authority);
        const predicted = await nextNonce(nonceAccount, nonce, execution);

        await sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer));
        expect((await clients.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(1_000_000n);
        expect((await fetchNonce(clients.rpc, nonceAccount, { commitment: 'confirmed' })).data.nonce).toBe(predicted);

        await expectCustomError(
            sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer)),
            3,
        );
        expect((await clients.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(1_000_000n);
    });

    it('a tampered authorization is rejected', async () => {
        const { authority, nonce, nonceAccount, pda, relayer } = await setup(clients);
        const recipient = (await generateKeyPairSigner()).address;

        // Sign one amount, relay another.
        const signed = executionMessage(pda, solTransfer(pda, recipient, 1_000_000n), await nonce());
        const signature = await signAuthorization(
            authorizationMessage(signed, nonceAccount, pda, authority.address),
            authority,
        );
        const edited = executionMessage(pda, solTransfer(pda, recipient, 2_000_000n), await nonce());
        const authorization = authorizationMessage(edited, nonceAccount, pda, authority.address);
        await expectCustomError(
            sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer)),
            3,
        );
        expect((await clients.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value).toBe(0n);
    });
});

describe.skipIf(!live)('token-transfer', () => {
    const clients = createClients();

    it('a cold-signed token withdrawal creates the destination and lands', async () => {
        const { authority, nonce, nonceAccount, pda, relayer } = await setup(clients);
        const recipient = (await generateKeyPairSigner()).address;
        const mint = await createMint(clients, relayer);
        const pdaAccount = await mintToAta(clients, relayer, mint, pda, 1_000_000_000n);
        const initial = await nonce();

        const execution = executionMessage(pda, await tokenTransfer(mint, pda, recipient, 250_000_000n), initial);
        const authorization = authorizationMessage(execution, nonceAccount, pda, authority.address);
        const signature = await signAuthorization(authorization, authority);
        const predicted = await nextNonce(nonceAccount, initial, execution);

        await sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer));
        expect(await fetchBalance(clients.rpc, await associatedTokenAddress(recipient, mint))).toBe(250_000_000n);
        expect(await fetchBalance(clients.rpc, pdaAccount)).toBe(750_000_000n);
        expect(await nonce()).toBe(predicted);
        await expectCustomError(
            sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer)),
            3,
        );
    });
});
