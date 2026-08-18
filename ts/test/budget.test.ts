/** Offline tests for reading a compute budget across all three versions. */

import {
    getRequestHeapFrameInstruction,
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
    getSetLoadedAccountsDataSizeLimitInstruction,
} from '@solana-program/compute-budget';
import { describe, expect, it } from 'vitest';

import { computeBudgetOfMessage, defaultComputeUnitLimit } from '../src/lib/budget';
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
