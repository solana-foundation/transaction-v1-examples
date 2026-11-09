import { LOADER_V3_PROGRAM_ADDRESS } from '@solana-program/loader-v3';
import {
    createDecoderThatConsumesEntireByteArray,
    downgradeRoleToNonSigner,
    downgradeRoleToReadonly,
    getAccountMetasFromCompiledTransactionMessage,
    getCompiledTransactionMessageDecoder,
    type AccountMeta,
    type CompiledTransactionMessage,
    type ReadonlyUint8Array,
} from '@solana/kit';

type MessageAccountsResolverScope = Readonly<{
    args: Readonly<{ message: ReadonlyUint8Array }>;
}>;

type V1CompiledTransactionMessage = Extract<CompiledTransactionMessage, { version: 1 }>;

const compiledMessageDecoder = createDecoderThatConsumesEntireByteArray(getCompiledTransactionMessageDecoder());

/**
 * Resolves the remaining `Execute` accounts from the execution message's static account list.
 * Accounts keep the order and permissions they would have in a normal Solana transaction.
 * Throws for a message that is not v1, which the executor rejects.
 *
 * Mirrors `executor/client/src/instruction.rs`.
 */
export const resolveExecutionMessageAccounts = (scope: MessageAccountsResolverScope): AccountMeta[] => {
    const message = decodeV1Message(scope.args.message, 'The message executor only supports v1 execution messages');
    return getStaticAccountMetas(message);
};

/**
 * Resolves the remaining `Submit` accounts from the authorization message's static account list.
 * Account order and writable privileges match the authorization message, while signer privileges
 * are removed because authorities sign the authorization message, not the relay transaction.
 *
 * Any required signer can sign the relay transaction instead of the authorization message. To do
 * so, the caller passes `null` as that signer's entry in `signatures`, then applies
 * `upgradeRoleToSigner` to its account in the `Submit` instruction and signs the relay transaction
 * with it. Submit never promotes that signer's `ProgrammaticSigner` PDA. It forwards the signer's
 * privilege to the executor only when the executor uses the signer directly. A signer the executor
 * does not use, such as a required relay signer, only approves the submission.
 *
 * Throws for a message that is not v1, which the signer program rejects.
 *
 * Mirrors `signer/client/src/instruction.rs`.
 */
export const resolveAuthorizationMessageAccounts = (scope: MessageAccountsResolverScope): AccountMeta[] => {
    const message = decodeV1Message(scope.args.message, 'The signer program only supports v1 authorization messages');
    return getStaticAccountMetas(message).map(account => ({
        ...account,
        // Authority signatures cover the authorization message, not the relay transaction that submits it.
        role: downgradeRoleToNonSigner(account.role),
    }));
};

// Decodes a message that the programs accept, which must be v1.
const decodeV1Message = (bytes: ReadonlyUint8Array, errorMessage: string): V1CompiledTransactionMessage => {
    const message = compiledMessageDecoder.decode(bytes);
    if (message.version !== 1) {
        const version = message.version === 'legacy' ? 'legacy' : `v${message.version}`;
        throw new Error(`${errorMessage}, got a ${version} message`);
    }
    return message;
};

// Builds account metas out of a message's static account list.
const getStaticAccountMetas = (message: V1CompiledTransactionMessage): AccountMeta[] => {
    const programAccountIndexes = getProgramAccountIndexes(message);

    // Program accounts are normally readonly, but must remain writable when the upgradeable loader may upgrade one.
    const hasUpgradeableLoader = message.staticAccounts.includes(LOADER_V3_PROGRAM_ADDRESS);

    return getAccountMetasFromCompiledTransactionMessage(message).map((account, index) => {
        const isDemotedProgram = programAccountIndexes.has(index) && !hasUpgradeableLoader;
        return {
            ...account,
            role: isDemotedProgram ? downgradeRoleToReadonly(account.role) : account.role,
        };
    });
};

const getProgramAccountIndexes = (message: V1CompiledTransactionMessage): Set<number> => {
    return new Set(message.instructionHeaders.map(instruction => instruction.programAccountIndex));
};
