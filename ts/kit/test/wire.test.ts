/**
 * Offline tests for the v1 wire format and version discrimination.
 *
 * Nothing here needs a validator.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    address,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase64Encoder,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    getTransactionMessageComputeUnitLimit,
    getTransactionMessageHeapSize,
    getTransactionMessagePriorityFeeLamports,
    lamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageComputeUnitPrice,
    setTransactionMessageConfig,
    setTransactionMessageFeePayer,
    setTransactionMessageHeapSize,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    setTransactionMessagePriorityFeeLamports,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { formatComputeBudget } from '../src/lib/budget';
import { messageVersion } from '../src/lib/grpc';
import { decodeTransactionVersion, EXAMPLE_CONFIG } from '../src/lib/v1';
import { grpcMessage } from './fixtures';

const FEE_PAYER = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const RECIPIENT = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const LIFETIME = {
    blockhash: blockhash('11111111111111111111111111111111'),
    lastValidBlockHeight: 100n,
} as const;

function buildV1Message() {
    return pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(FEE_PAYER, m),
        m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        m =>
            appendTransactionMessageInstruction(
                getTransferSolInstruction({
                    amount: lamports(1n),
                    destination: RECIPIENT,
                    source: createNoopSigner(FEE_PAYER),
                }),
                m,
            ),
        m => setTransactionMessagePriorityFeeLamports(EXAMPLE_CONFIG.priorityFeeLamports, m),
        m => setTransactionMessageComputeUnitLimit(EXAMPLE_CONFIG.computeUnitLimit, m),
        m => setTransactionMessageLoadedAccountsDataSizeLimit(EXAMPLE_CONFIG.loadedAccountsDataSizeLimit, m),
        m => setTransactionMessageHeapSize(EXAMPLE_CONFIG.heapSize, m),
    );
}

describe('createTransactionMessage', () => {
    it('should accept version 1', () => {
        const message = createTransactionMessage({ version: 1 });
        expect(message.version).toBe(1);
        expect(message.instructions).toHaveLength(0);
    });
});

describe('the v1 compute budget setters', () => {
    it('should write the budget into config rather than into instructions', () => {
        const message = buildV1Message();
        expect(message.config).toStrictEqual({
            computeUnitLimit: 20_000,
            heapSize: 65_536,
            loadedAccountsDataSizeLimit: 65_536,
            priorityFeeLamports: 5_000n,
        });
        expect(message.instructions).toHaveLength(1);
    });

    it('should express the priority fee as total lamports', () => {
        const message = buildV1Message();
        expect(getTransactionMessagePriorityFeeLamports(message)).toBe(5_000n);
    });

    it('should leave unset fields absent rather than defaulted', () => {
        const message = setTransactionMessageComputeUnitLimit(1_000, createTransactionMessage({ version: 1 }));
        expect(message.config).toStrictEqual({ computeUnitLimit: 1_000 });
        expect(getTransactionMessagePriorityFeeLamports(message)).toBeUndefined();
    });
});

describe('setTransactionMessageComputeUnitLimit', () => {
    it('should target config on v1 and an instruction on v0', () => {
        const v1 = setTransactionMessageComputeUnitLimit(20_000, createTransactionMessage({ version: 1 }));
        const v0 = setTransactionMessageComputeUnitLimit(20_000, createTransactionMessage({ version: 0 }));

        expect(v1.config).toStrictEqual({ computeUnitLimit: 20_000 });
        expect(v1.instructions).toHaveLength(0);

        expect(v0.instructions).toHaveLength(1);
        expect(getTransactionMessageComputeUnitLimit(v0)).toBe(20_000);
    });
});

describe('setTransactionMessageHeapSize', () => {
    it('should target config on v1 and an instruction on v0', () => {
        const v1 = setTransactionMessageHeapSize(65_536, createTransactionMessage({ version: 1 }));
        const v0 = setTransactionMessageHeapSize(65_536, createTransactionMessage({ version: 0 }));

        expect(v1.config).toStrictEqual({ heapSize: 65_536 });
        expect(v1.instructions).toHaveLength(0);
        expect(v0.instructions).toHaveLength(1);
    });
});

describe('setTransactionMessageLoadedAccountsDataSizeLimit', () => {
    it('should target config on v1 and an instruction on v0', () => {
        const v1 = setTransactionMessageLoadedAccountsDataSizeLimit(65_536, createTransactionMessage({ version: 1 }));
        const v0 = setTransactionMessageLoadedAccountsDataSizeLimit(65_536, createTransactionMessage({ version: 0 }));

        expect(v1.config).toStrictEqual({ loadedAccountsDataSizeLimit: 65_536 });
        expect(v1.instructions).toHaveLength(0);
        expect(v0.instructions).toHaveLength(1);
    });
});

describe('the version-restricted priority fee setters', () => {
    // The other three setters accept every version and route by it. The fee is
    // the exception: micro-lamports per CU and a total in lamports are
    // different quantities, so they get different setters.
    it('should confine the total-lamports setter to v1', () => {
        // @ts-expect-error `setTransactionMessagePriorityFeeLamports` accepts v1 messages only.
        const v0 = setTransactionMessagePriorityFeeLamports(5_000n, createTransactionMessage({ version: 0 }));

        // Only the type system rejects this. At runtime the fee lands in a
        // `config` on a v0 message, where nothing will ever read it.
        expect((v0 as { config?: unknown }).config).toStrictEqual({ priorityFeeLamports: 5_000n });
        expect(v0.instructions).toHaveLength(0);
    });

    it('should confine the micro-lamports-per-unit setter to legacy and v0', () => {
        // @ts-expect-error `setTransactionMessageComputeUnitPrice` accepts legacy and v0 messages only.
        const v1 = setTransactionMessageComputeUnitPrice(250_000n, createTransactionMessage({ version: 1 }));

        // Again only the type system objects. The runtime appends a
        // ComputeBudget instruction to a v1 message, which is malformed.
        expect(v1.instructions).toHaveLength(1);
        expect((v1 as { config?: unknown }).config).toBeUndefined();
    });
});

describe('setTransactionMessageConfig', () => {
    it('should merge into an existing config rather than replace it', () => {
        const message = pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageConfig({ computeUnitLimit: 20_000 }, m),
            m => setTransactionMessageConfig({ priorityFeeLamports: 5_000n }, m),
        );

        expect(message.config).toStrictEqual({ computeUnitLimit: 20_000, priorityFeeLamports: 5_000n });
    });

    it('should unset a single field when it is given undefined', () => {
        const message = pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
            m => setTransactionMessageConfig({ heapSize: undefined }, m),
        );

        // An explicit `undefined` overwrites the value but leaves the key in
        // place. Kit reads field by field and treats that as missing, so the
        // distinction never reaches the wire.
        expect(message.config).toStrictEqual({
            computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
            heapSize: undefined,
            loadedAccountsDataSizeLimit: EXAMPLE_CONFIG.loadedAccountsDataSizeLimit,
            priorityFeeLamports: EXAMPLE_CONFIG.priorityFeeLamports,
        });
        expect(getTransactionMessageHeapSize(message)).toBeUndefined();
    });

    it('should leave the unset field out of the compiled config', () => {
        const withoutHeap = pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageFeePayer(FEE_PAYER, m),
            m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
            m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
            m => setTransactionMessageConfig({ heapSize: undefined }, m),
        );

        const decoded = decodeTransactionVersion(
            getBase64Encoder().encode(getBase64EncodedWireTransaction(compileTransaction(withoutHeap))),
        );
        expect(decoded.config).toStrictEqual({
            computeUnitLimit: EXAMPLE_CONFIG.computeUnitLimit,
            loadedAccountsDataSizeLimit: EXAMPLE_CONFIG.loadedAccountsDataSizeLimit,
            priorityFeeLamports: EXAMPLE_CONFIG.priorityFeeLamports,
        });
    });

    it('should drop the config entirely once its last field is removed', () => {
        // An absent config is the signal that identifies a v1 message on the
        // gRPC wire, so emptying it is not the same as leaving it in place with
        // nothing set.
        const message = pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageComputeUnitLimit(20_000, m),
            m => setTransactionMessageComputeUnitLimit(undefined, m),
        );

        expect('config' in message).toBe(false);
        expect(message.version).toBe(1);
    });
});

describe('the v1 wire format', () => {
    it('should prefix a compiled message with 0x81', () => {
        const transaction = compileTransaction(buildV1Message());
        expect(transaction.messageBytes[0]).toBe(0x81);
    });

    it('should round-trip the config through encode and decode', () => {
        const transaction = compileTransaction(buildV1Message());
        const wire = getBase64Encoder().encode(getBase64EncodedWireTransaction(transaction));

        const decoded = decodeTransactionVersion(wire);
        expect(decoded.version).toBe(1);
        expect(decoded.config).toStrictEqual(EXAMPLE_CONFIG);
    });

    it('should compile without an address table lookup section', () => {
        const compiled = getCompiledTransactionMessageDecoder().decode(
            compileTransaction(buildV1Message()).messageBytes,
        );
        expect(compiled.version).toBe(1);
        expect('addressTableLookups' in compiled).toBe(false);
    });
});

describe('messageVersion', () => {
    it('should key on the presence of config rather than on versioned', () => {
        expect(messageVersion(grpcMessage({ config: {}, versioned: true }))).toBe('v1');
        expect(messageVersion(grpcMessage({ versioned: true }))).toBe('v0');
        expect(messageVersion(grpcMessage({ versioned: false }))).toBe('legacy');
    });

    it('should identify a v1 message whose config fields are all absent', () => {
        // Every config field is optional, so presence of the config — not its
        // contents — is the version signal.
        expect(messageVersion(grpcMessage({ config: {}, versioned: true }))).toBe('v1');
    });
});

describe('formatComputeBudget', () => {
    it('should spell out what each absent field resolves to', () => {
        const rendered = formatComputeBudget({});
        expect(rendered).toContain('priorityFee:                  unset (0)');
        expect(rendered).toContain('computeUnitLimit:             unset (0)');
        expect(rendered).toContain('loadedAccountsDataSizeLimit:  unset (0)');
        expect(rendered).toContain('heapSize:                     unset (32KB default)');
    });
});
