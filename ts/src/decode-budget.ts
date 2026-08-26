/**
 * Reads the compute budget out of a base64 transaction, whatever its version.
 *
 * The three versions state the same budget in two different places, in two
 * different units, so a consumer that only knows one of them reports the
 * others wrong rather than failing: a pipeline that scans ComputeBudget
 * instructions sees no budget at all on v1, and one that reads `config` sees
 * none on legacy or v0. `computeBudgetOfBase64Transaction` switches on the
 * decoded version and normalises both into v1's four fields.
 *
 * With no argument this builds one transaction per version, each carrying the
 * same budget, and prints what comes back out. Pass a base64 transaction to
 * read that one instead:
 *
 *     just ts-decode-budget "$(solana -u m confirm -v <signature> …)"
 *
 * Run with `just ts-decode-budget`. Needs no validator.
 */

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
    setTransactionMessageHeapSize,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    type TransactionMessage,
    type TransactionMessageWithFeePayer,
} from '@solana/kit';

type BaseMessage = TransactionMessage & TransactionMessageWithFeePayer;

import { computeBudgetOfBase64Transaction, formatComputeBudget } from './lib/budget';
import { EXAMPLE_CONFIG } from './lib/v1';

const FEE_PAYER = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const RECIPIENT = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const LIFETIME = { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 100n } as const;

/**
 * The per-compute-unit price that costs the same as {@link EXAMPLE_CONFIG}'s
 * total, at that config's compute unit limit.
 *
 * 20,000 CU × 250,000 micro-lamports/CU = 5,000 lamports.
 */
const EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU =
    (EXAMPLE_CONFIG.priorityFeeLamports * 1_000_000n) / BigInt(EXAMPLE_CONFIG.computeUnitLimit);

const TRANSFER = getTransferSolInstruction({
    amount: lamports(1n),
    destination: RECIPIENT,
    source: createNoopSigner(FEE_PAYER),
});

/**
 * The four ComputeBudget instructions that state the budget on legacy and v0.
 *
 * Each setter appends one instruction, so the budget costs four instructions
 * and four accounts' worth of message space on top of the transfer.
 */
function withComputeBudgetInstructions<TMessage extends BaseMessage & { version: 0 | 'legacy' }>(message: TMessage) {
    return pipe(
        message,
        m => setTransactionMessageComputeUnitLimit(EXAMPLE_CONFIG.computeUnitLimit, m),
        m => setTransactionMessageComputeUnitPrice(EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU, m),
        m => setTransactionMessageLoadedAccountsDataSizeLimit(EXAMPLE_CONFIG.loadedAccountsDataSizeLimit, m),
        m => setTransactionMessageHeapSize(EXAMPLE_CONFIG.heapSize, m),
    );
}

function legacyTransaction(): string {
    return toBase64(
        withComputeBudgetInstructions(
            pipe(
                createTransactionMessage({ version: 'legacy' }),
                m => setTransactionMessageFeePayer(FEE_PAYER, m),
                m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
                m => appendTransactionMessageInstruction(TRANSFER, m),
            ),
        ),
    );
}

function v0Transaction(): string {
    return toBase64(
        withComputeBudgetInstructions(
            pipe(
                createTransactionMessage({ version: 0 }),
                m => setTransactionMessageFeePayer(FEE_PAYER, m),
                m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
                m => appendTransactionMessageInstruction(TRANSFER, m),
            ),
        ),
    );
}

function v1Transaction(): string {
    return toBase64(
        pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageFeePayer(FEE_PAYER, m),
            m => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
            m => appendTransactionMessageInstruction(TRANSFER, m),
            // The whole budget is one field on the message, so the instruction
            // list still holds only the transfer.
            m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
        ),
    );
}

/** Serializes a message the way a client hands one to a server: compiled, then base64. */
function toBase64(message: BaseMessage): string {
    return getBase64EncodedWireTransaction(compileTransaction(message));
}

function report(label: string, base64EncodedTransaction: string): void {
    const { budget, version } = computeBudgetOfBase64Transaction(base64EncodedTransaction);
    console.log(`\n== ${label} ==`);
    console.log(`  version: ${version}`);
    console.log(formatComputeBudget(budget));
}

const [, , base64FromArgv] = process.argv;

if (base64FromArgv) {
    report('from the argument', base64FromArgv);
} else {
    console.log(
        `The same budget three ways: a priority fee of ${EQUIVALENT_PRICE_MICRO_LAMPORTS_PER_CU} micro-lamports/CU on`,
    );
    console.log(
        `legacy and v0, and ${EXAMPLE_CONFIG.priorityFeeLamports} lamports on v1 — the same cost at ${EXAMPLE_CONFIG.computeUnitLimit} CU.`,
    );

    report('legacy', legacyTransaction());
    report('v0', v0Transaction());
    report('v1', v1Transaction());
}
