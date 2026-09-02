import {
    flattenInstructionPlan,
    getSignersFromInstruction,
    type Instruction,
    type InstructionPlan,
    isInstructionPlan,
    isMessagePartialSigner,
    isSingleInstructionPlan,
    type MessagePartialSigner,
} from '@solana/kit';
import {
    Connection,
    Keypair,
    MessageV1,
    type TransactionInstruction,
    type V1TransactionConfig,
    VersionedTransaction,
} from '@solana/web3.js';

export type V1InstructionInput = Instruction | InstructionPlan | TransactionInstruction;

export const PRIORITY_FEE_LAMPORTS = 5_000n;

export const COMPUTE_UNIT_LIMIT = 1_400_000;

export const LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 64 * 1024 * 1024;

export const RPC_URL = process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899';

export const json = (value: unknown) =>
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry));

export function flattenInstructions(
    inputs: ReadonlyArray<V1InstructionInput>,
): Array<Instruction | TransactionInstruction> {
    return inputs.flatMap(input => {
        if (!isInstructionPlan(input)) {
            return [input];
        }
        return [...flattenInstructionPlan(input)].map(leaf => {
            if (!isSingleInstructionPlan(leaf)) {
                throw new Error(`instruction plan leaf "${leaf.kind}" cannot fit in a single transaction`);
            }
            return leaf.instruction;
        });
    });
}

function collectSigners(
    payer: Keypair,
    instructions: ReadonlyArray<Instruction | TransactionInstruction>,
): MessagePartialSigner[] {
    const signers = new Map<string, MessagePartialSigner>([[payer.address, payer]]);
    for (const instruction of instructions) {
        if (!('accounts' in instruction)) {
            continue;
        }
        for (const signer of getSignersFromInstruction(instruction)) {
            if (isMessagePartialSigner(signer) && !signers.has(signer.address)) {
                signers.set(signer.address, signer);
            }
        }
    }
    return [...signers.values()];
}

export async function sendV1Transaction(
    connection: Connection,
    payer: Keypair,
    inputs: ReadonlyArray<V1InstructionInput>,
    config?: V1TransactionConfig,
): Promise<{ signature: string; transaction: VersionedTransaction }> {
    const instructions = flattenInstructions(inputs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const message = MessageV1.compile({
        instructions,
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
    await transaction.sign(collectSigners(payer, instructions));

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
