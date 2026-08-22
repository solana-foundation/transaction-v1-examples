/**
 * Tests that run against a live validator.
 *
 * Skipped unless `TXV1_LIVE=1`, which `just test-live` sets after starting a
 * 4.2.1 validator with the Yellowstone geyser plugin.
 */

import { fetchMint, fetchToken } from '@solana-program/token-2022';
import {
    fetchConfidentialTransferBalance,
    getConfidentialTransferInstructionPlan,
} from '@solana-program/token-2022/confidential';
import {
    airdropFactory,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    flattenInstructionPlan,
    generateKeyPairSigner,
    getTransactionMessageSize,
    getTransactionMessageSizeLimit,
    isSingleInstructionPlan,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessagePriorityFeeLamports,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { computeBudgetOfMessage } from '../src/lib/budget';
import {
    applyPendingBalance,
    type ConfidentialParty,
    createConfidentialMint,
    createConfidentialParty,
    fundConfidentially,
} from '../src/lib/confidential';
import {
    ALL_TRANSACTIONS_REQUEST,
    DEFAULT_GRPC_ENDPOINT,
    type GrpcMessage,
    messageVersion,
    subscribe,
    type SubscribeUpdate,
} from '../src/lib/grpc';
import { BLOCK_CONFIG } from '../src/lib/rpc';
import {
    buildV1Transfer,
    type Clients,
    createClients,
    sendAndConfirm,
    sendV1TransferAndGetSlot,
} from '../src/lib/send';
import { EXAMPLE_CONFIG } from '../src/lib/v1';

const live = process.env.TXV1_LIVE === '1';

async function sendV1(clients: Clients) {
    return await sendAndConfirm(clients, await buildV1Transfer(clients));
}

/**
 * Resolves with the first v1 message the stream delivers.
 *
 * The rejection paths matter as much as the resolution: without them a plugin
 * that downgrades v1 to v0 shows up as a test that hangs to the suite timeout
 * rather than as the failure it is.
 */
function firstV1Message(stream: Awaited<ReturnType<typeof subscribe>>['stream']): Promise<GrpcMessage> {
    return new Promise<GrpcMessage>((resolve, reject) => {
        stream.on('data', (update: SubscribeUpdate) => {
            const message = update.transaction?.transaction?.transaction?.message;
            if (message && messageVersion(message) === 'v1') {
                resolve(message);
            }
        });
        stream.on('error', reject);
        stream.on('end', () => reject(new Error('stream ended before a v1 transaction arrived')));
        setTimeout(() => reject(new Error('timed out waiting for a v1 transaction')), 45_000).unref();
    });
}

describe.skipIf(!live)('getTransaction', () => {
    it('should report version 1 and expose the transaction config', async () => {
        const clients = createClients();
        const signature = await sendV1(clients);

        const fetched = await clients.rpc
            .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
            .send();

        expect(fetched?.version).toBe(1);
        // The three `u32` fields come back as numbers and only the priority
        // fee, a `u64`, is a bigint.
        expect(fetched!.transaction.message.transactionConfig).toStrictEqual({
            computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
            heapSize: EXAMPLE_CONFIG.heapSize,
            loadedAccountsDataSizeLimit: EXAMPLE_CONFIG.loadedAccountsDataSizeLimit,
            priorityFee: EXAMPLE_CONFIG.priorityFeeLamports,
        });
    });

    it('should reject a v1 transaction when the version ceiling is too low', async () => {
        const clients = createClients();
        const signature = await sendV1(clients);

        await expect(
            clients.rpc.getTransaction(signature, { commitment: 'confirmed', encoding: 'json' }).send(),
        ).rejects.toThrow(/maxSupportedTransactionVersion/);
        await expect(
            clients.rpc
                .getTransaction(signature, {
                    commitment: 'confirmed',
                    encoding: 'json',
                    maxSupportedTransactionVersion: 0,
                })
                .send(),
        ).rejects.toThrow(/maxSupportedTransactionVersion/);
    });
});

describe.skipIf(!live)('getBlock', () => {
    it('should fail entirely when the block holds a v1 transaction', async () => {
        const clients = createClients();
        const { slot } = await sendV1TransferAndGetSlot(clients);

        // The whole block is refused, not just the v1 transaction inside it.
        await expect(
            clients.rpc.getBlock(slot, { ...BLOCK_CONFIG, maxSupportedTransactionVersion: 0 }).send(),
        ).rejects.toThrow(/maxSupportedTransactionVersion/);

        const block = await clients.rpc.getBlock(slot, { ...BLOCK_CONFIG, maxSupportedTransactionVersion: 1 }).send();
        expect(block?.transactions.some(transaction => transaction.version === 1)).toBe(true);
    });
});

describe.skipIf(!live)('the gRPC transaction stream', () => {
    it('should deliver the v1 config intact', async () => {
        const { close, stream } = await subscribe(DEFAULT_GRPC_ENDPOINT, ALL_TRANSACTIONS_REQUEST);
        try {
            const firstV1 = firstV1Message(stream);

            await sendV1(createClients());
            const message = await firstV1;

            expect(message.versioned).toBe(true);
            expect(message.config).toStrictEqual({
                computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
                heapSize: EXAMPLE_CONFIG.heapSize,
                loadedAccountsDataSizeLimit: EXAMPLE_CONFIG.loadedAccountsDataSizeLimit,
                priorityFee: `${EXAMPLE_CONFIG.priorityFeeLamports}`,
            });
            expect(message.addressTableLookups).toHaveLength(0);
        } finally {
            close();
        }
    });

    it('should report the same budget through the version-agnostic accessor', async () => {
        const { close, stream } = await subscribe(DEFAULT_GRPC_ENDPOINT, ALL_TRANSACTIONS_REQUEST);
        try {
            const firstV1 = firstV1Message(stream);

            await sendV1(createClients());
            const budget = computeBudgetOfMessage(await firstV1);

            expect(budget.computeUnitLimit).toBe(EXAMPLE_CONFIG.computeUnitLimit);
            expect(budget.priorityFeeLamports).toBe(EXAMPLE_CONFIG.priorityFeeLamports);
        } finally {
            close();
        }
    });
});

describe.skipIf(!live)('a Token-2022 confidential transfer', () => {
    it('should fit the whole plan in one v1 transaction and settle both balances', async () => {
        const clients = createClients();
        const payer = await generateKeyPairSigner();
        await airdropFactory(clients)({
            commitment: 'confirmed',
            lamports: lamports(20_000_000_000n),
            recipientAddress: payer.address,
        });

        const mint = await createConfidentialMint(clients, payer);
        const sender = await createConfidentialParty(clients, payer, mint, payer);
        const recipient = await createConfidentialParty(clients, payer, mint, await generateKeyPairSigner());
        await fundConfidentially(clients, payer, mint, sender, 10_000n);

        const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
            fetchMint(clients.rpc, mint),
            fetchToken(clients.rpc, sender.token),
            fetchToken(clients.rpc, recipient.token),
        ]);
        const plan = await getConfidentialTransferInstructionPlan({
            aesKey: sender.aesKey,
            amount: 2_500n,
            authority: sender.owner,
            destinationToken: recipient.token,
            destinationTokenAccount: destinationAccount.data,
            mint,
            mintAccount: mintAccount.data,
            payer,
            rpc: clients.rpc,
            sourceElgamalKeypair: sender.elgamalKeypair,
            sourceToken: sender.token,
            sourceTokenAccount: sourceAccount.data,
        });

        const instructions = flattenInstructionPlan(plan).map(single => {
            if (!isSingleInstructionPlan(single)) {
                throw new Error('the transfer plan holds an instruction that has to be sized against a message');
            }
            return single.instruction;
        });

        const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        const draft = pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageFeePayerSigner(payer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
            m => appendTransactionMessageInstructions(instructions, m),
            m => setTransactionMessagePriorityFeeLamports(5_000n, m),
            fillTransactionMessageProvisoryResourceLimits,
        );
        const message = await estimateAndSetResourceLimitsFactory(estimateResourceLimitsFactory({ rpc: clients.rpc }))(
            draft,
            { commitment: 'confirmed' },
        );

        // The whole transfer is one transaction, and one no legacy or v0 message
        // could have held.
        expect(getTransactionMessageSize(message)).toBeGreaterThan(1232);
        expect(getTransactionMessageSize(message)).toBeLessThanOrEqual(getTransactionMessageSizeLimit(message));

        const transaction = await signTransactionMessageWithSigners(message);
        assertIsTransactionWithBlockhashLifetime(transaction);
        await sendAndConfirm(clients, transaction);
        await applyPendingBalance(clients, payer, recipient);

        const balanceOf = async (party: ConfidentialParty) =>
            await fetchConfidentialTransferBalance({
                aesKey: party.aesKey,
                elgamalSecretKey: party.elgamalKeypair.secret(),
                rpc: clients.rpc,
                token: party.token,
            });

        expect((await balanceOf(sender)).availableBalance).toBe(7_500n);
        expect((await balanceOf(recipient)).availableBalance).toBe(2_500n);
    }, 180_000);
});
