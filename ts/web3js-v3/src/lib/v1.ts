import type { Instruction, InstructionPlan, MessagePartialSigner } from '@solana/kit';
import {
    Connection,
    Keypair,
    MessageV1,
    type TransactionInstruction,
    type V1TransactionConfig,
    VersionedTransaction,
} from '@solana/web3.js';

export const PRIORITY_FEE_LAMPORTS = 5_000n;

export const COMPUTE_UNIT_LIMIT = 1_400_000;

export const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

export const RPC_URL = process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899';

export const json = (value: unknown) =>
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry));

export async function sendV1Transaction(
    connection: Connection,
    payer: Keypair,
    instructions: ReadonlyArray<Instruction | InstructionPlan | TransactionInstruction>,
    signers: ReadonlyArray<MessagePartialSigner> = [],
    config?: V1TransactionConfig,
): Promise<{ signature: string; transaction: VersionedTransaction }> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = MessageV1.compile({
        instructions: [...instructions],
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        transactionConfig: {
            computeUnitLimit: COMPUTE_UNIT_LIMIT,
            loadedAccountsDataSizeLimit: LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
            priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
            ...config,
        },
    });

    const transaction = new VersionedTransaction(message);
    await transaction.sign([payer, ...signers]);

    const signature = await connection.sendTransaction(transaction, { preflightCommitment: 'confirmed' });
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');
    return { signature, transaction };
}

export async function fundedKeypair(connection: Connection, lamports: number): Promise<Keypair> {
    const keypair = await Keypair.generate();
    const signature = await connection.requestAirdrop(keypair.publicKey, lamports);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');
    return keypair;
}
