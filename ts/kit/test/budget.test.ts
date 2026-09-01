/** Offline tests for reading a compute budget across all three versions. */

import {
    getRequestHeapFrameInstruction,
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
    getSetLoadedAccountsDataSizeLimitInstruction,
} from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    address,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    lamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageComputeUnitPrice,
    setTransactionMessageConfig,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type TransactionMessage,
    type TransactionMessageWithFeePayer,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { computeBudgetOfBase64Transaction, computeBudgetOfMessage, defaultComputeUnitLimit } from '../src/lib/budget';
import { EXAMPLE_CONFIG } from '../src/lib/v1';
import { compileInstruction, computeBudgetMessage, grpcMessage } from './fixtures';

describe('computeBudgetOfMessage', () => {
    it('should read a v1 budget straight off the config', () => {
        const budget = computeBudgetOfMessage(
            grpcMessage({
                config: {
                    computeUnitLimit: 20_000,
                    heapSize: 65_536,
                    loadedAccountsDataSizeLimit: 65_536,
                    priorityFee: '5000',
                },
                versioned: true,
            }),
        );

        expect(budget).toStrictEqual({
            computeUnitLimit: 20_000,
            heapSize: 65_536,
            loadedAccountsDataSizeLimit: 65_536,
            priorityFeeLamports: 5_000n,
        });
    });

    it('should recover a v0 budget from ComputeBudget instructions', () => {
        const budget = computeBudgetOfMessage(
            computeBudgetMessage([
                compileInstruction(getSetComputeUnitLimitInstruction({ units: 20_000 })),
                compileInstruction(getSetLoadedAccountsDataSizeLimitInstruction({ accountDataSizeLimit: 65_536 })),
                compileInstruction(getRequestHeapFrameInstruction({ bytes: 65_536 })),
            ]),
        );

        expect(budget.computeUnitLimit).toBe(20_000);
        expect(budget.loadedAccountsDataSizeLimit).toBe(65_536);
        expect(budget.heapSize).toBe(65_536);
    });

    it('should convert a v0 price in micro-lamports per unit into a total in lamports', () => {
        // 20,000 CU at 250,000 micro-lamports/CU is 5,000 lamports — the same
        // number a v1 transaction would state directly.
        const budget = computeBudgetOfMessage(
            computeBudgetMessage([
                compileInstruction(getSetComputeUnitLimitInstruction({ units: 20_000 })),
                compileInstruction(getSetComputeUnitPriceInstruction({ microLamports: 250_000n })),
            ]),
        );

        expect(budget.priorityFeeLamports).toBe(5_000n);
    });

    it('should round a fractional v0 fee up to whole lamports', () => {
        const budget = computeBudgetOfMessage(
            computeBudgetMessage([
                compileInstruction(getSetComputeUnitLimitInstruction({ units: 1 })),
                compileInstruction(getSetComputeUnitPriceInstruction({ microLamports: 1n })),
            ]),
        );

        expect(budget.priorityFeeLamports).toBe(1n);
    });

    it('should apply the implicit limit when a v0 price has no explicit limit', () => {
        const budget = computeBudgetOfMessage(
            computeBudgetMessage([
                compileInstruction(getSetComputeUnitPriceInstruction({ microLamports: 1_000_000n })),
            ]),
        );

        expect(defaultComputeUnitLimit(1)).toBe(200_000);
        expect(budget.priorityFeeLamports).toBe(200_000n);
    });

    it('should clamp the implicit limit to the maximum', () => {
        expect(defaultComputeUnitLimit(7)).toBe(1_400_000);
        expect(defaultComputeUnitLimit(100)).toBe(1_400_000);
    });

    it('should report nothing set for a transaction with no budget instructions', () => {
        expect(computeBudgetOfMessage(computeBudgetMessage([], false))).toStrictEqual({});
    });

    it('should ignore instructions from other programs', () => {
        const message = computeBudgetMessage([
            compileInstruction(getSetComputeUnitLimitInstruction({ units: 20_000 })),
        ]);
        message.accountKeys = [new Uint8Array(32).fill(7)];

        expect(computeBudgetOfMessage(message).computeUnitLimit).toBeUndefined();
    });

    it('should never fall back to instructions on a v1 message', () => {
        // A v1 message carrying a ComputeBudget instruction is malformed, but
        // the config is still the only authority — silently preferring the
        // instruction is the mix-up this accessor exists to prevent.
        const message = computeBudgetMessage([
            compileInstruction(getSetComputeUnitLimitInstruction({ units: 999_999 })),
        ]);
        message.config = { computeUnitLimit: 20_000 };

        expect(computeBudgetOfMessage(message).computeUnitLimit).toBe(20_000);
    });
});

const FEE_PAYER = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const RECIPIENT = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const LIFETIME = { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 100n } as const;

const TRANSFER = getTransferSolInstruction({
    amount: lamports(1n),
    destination: RECIPIENT,
    source: createNoopSigner(FEE_PAYER),
});

function legacyMessage() {
    return pipe(
        createTransactionMessage({ version: 'legacy' }),
        m => setTransactionMessageFeePayer(FEE_PAYER, m),
        m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        m => appendTransactionMessageInstruction(TRANSFER, m),
    );
}

function v0Message() {
    return pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(FEE_PAYER, m),
        m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        m => appendTransactionMessageInstruction(TRANSFER, m),
    );
}

function v1Message() {
    return pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(FEE_PAYER, m),
        m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        m => appendTransactionMessageInstruction(TRANSFER, m),
    );
}

function toBase64(message: TransactionMessage & TransactionMessageWithFeePayer): string {
    return getBase64EncodedWireTransaction(compileTransaction(message));
}

describe('computeBudgetOfBase64Transaction', () => {
    it('should read a v1 budget off the config', () => {
        const encoded = toBase64(setTransactionMessageConfig(EXAMPLE_CONFIG, v1Message()));

        expect(computeBudgetOfBase64Transaction(encoded)).toStrictEqual({
            budget: { ...EXAMPLE_CONFIG },
            version: 1,
        });
    });

    it("should recover an equivalent budget from a legacy transaction's ComputeBudget instructions", () => {
        // 20,000 CU at 250,000 micro-lamports/CU is the 5,000 lamports the v1
        // config states directly.
        const encoded = toBase64(
            pipe(
                legacyMessage(),
                m => setTransactionMessageComputeUnitLimit(EXAMPLE_CONFIG.computeUnitLimit, m),
                m => setTransactionMessageComputeUnitPrice(250_000n, m),
            ),
        );

        expect(computeBudgetOfBase64Transaction(encoded)).toStrictEqual({
            budget: {
                computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
                priorityFeeLamports: EXAMPLE_CONFIG.priorityFeeLamports,
            },
            version: 'legacy',
        });
    });

    it("should recover an equivalent budget from a v0 transaction's ComputeBudget instructions", () => {
        const encoded = toBase64(
            pipe(
                v0Message(),
                m => setTransactionMessageComputeUnitLimit(EXAMPLE_CONFIG.computeUnitLimit, m),
                m => setTransactionMessageComputeUnitPrice(250_000n, m),
            ),
        );

        expect(computeBudgetOfBase64Transaction(encoded)).toStrictEqual({
            budget: {
                computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
                priorityFeeLamports: EXAMPLE_CONFIG.priorityFeeLamports,
            },
            version: 0,
        });
    });

    it('should report nothing set for a transaction that states no budget', () => {
        expect(computeBudgetOfBase64Transaction(toBase64(v0Message()))).toStrictEqual({ budget: {}, version: 0 });
    });

    it('should charge the implicit limit when a transaction prices units without limiting them', () => {
        // Two instructions: the transfer and the price itself.
        const encoded = toBase64(pipe(legacyMessage(), m => setTransactionMessageComputeUnitPrice(1_000_000n, m)));

        expect(computeBudgetOfBase64Transaction(encoded).budget.priorityFeeLamports).toBe(
            BigInt(defaultComputeUnitLimit(2)),
        );
    });
});
