/**
 * Building, signing, and relaying the three layers of a programmatic signer action.
 *
 * ```text
 * relay transaction        signed by the hot relayer, fresh blockhash, pays the fee
 * └─ Submit instruction    to the Signer program
 *    └─ authorization message   signed by the cold authority, no blockhash, no expiry
 *       └─ Execute instruction  to the Executor program
 *          └─ execution message     fee payer and signer are the PDA, "blockhash" is the nonce
 *             └─ the action          an ordinary System transfer from the PDA
 * ```
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    type Blockhash,
    compileTransactionMessage,
    createNoopSigner,
    createTransactionMessage,
    getBase58Decoder,
    getBase64Decoder,
    getCompiledTransactionMessageEncoder,
    getSignatureFromTransaction,
    type Instruction,
    isWritableRole,
    type KeyPairSigner,
    pipe,
    type ReadonlyUint8Array,
    sendAndConfirmTransactionFactory,
    type SendableTransaction,
    setTransactionMessageConfig,
    setTransactionMessageFeePayer,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    type SignatureBytes,
    signBytes,
    signTransactionMessageWithSigners,
    type Transaction,
    type TransactionWithBlockhashLifetime,
    type V1CompiledTransactionMessage,
    type V1TransactionConfig,
} from '@solana/kit';

import {
    findProgrammaticSignerPda,
    getExecuteInstructionDataEncoder,
    getSubmitInstruction,
    MESSAGE_EXECUTOR_PROGRAM_ADDRESS,
    NONCE_PROGRAM_ADDRESS,
    resolveExecutionMessageAccounts,
} from '../client';
import type { Clients } from './rpc';

/**
 * The address that acts for `authority`: a PDA of the Signer program.
 *
 * Nothing is created on chain. It is a plain System-owned address that holds
 * SOL and owns token accounts like any wallet, and the Signer program promotes
 * it to a signer whenever `authority` has signed an authorization for it.
 */
export async function programmaticSigner(authority: Address): Promise<Address> {
    const [address] = await findProgrammaticSignerPda({ authority });
    return address;
}

/**
 * The budget the relay transaction requests.
 *
 * Unset v1 limits are zero, not the legacy defaults, so the relayer has to
 * state them. The Signer and Executor programs plus one promoted PDA cost
 * about 55,000 compute units for a SOL transfer; the limit leaves room for a
 * larger action without being the 1.4 million maximum the Anza CLI requests.
 */
export const RELAY_CONFIG: V1TransactionConfig = {
    computeUnitLimit: 200_000,
    loadedAccountsDataSizeLimit: 4 * 1024 * 1024,
};

/**
 * A System transfer whose source signs by promotion rather than with a key.
 *
 * `getTransferSolInstruction` wants a signer for the source, and the PDA has
 * no key. A noop signer carries its address and the signer role without ever
 * producing a signature; inside the execution message that role is all that
 * matters, and the Signer program makes it true at execution time.
 */
export function transferFromPda(pda: Address, destination: Address, amount: bigint): Instruction {
    return getTransferSolInstruction({ amount, destination, source: createNoopSigner(pda) });
}

/**
 * The `Execute` instruction the executor runs: the nonce accounts, then every
 * account of the execution message in order with the privileges it holds
 * there. Mirrors `execute` in the Anza executor client.
 */
export function executeInstruction(
    executionMessage: ReadonlyUint8Array,
    nonceAccount: Address,
    nonceAuthority: Address,
): Instruction {
    return {
        accounts: [
            { address: nonceAuthority, role: AccountRole.READONLY_SIGNER },
            { address: nonceAccount, role: AccountRole.WRITABLE },
            { address: NONCE_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            ...resolveExecutionMessageAccounts({ args: { message: executionMessage } }),
        ],
        data: getExecuteInstructionDataEncoder().encode({ message: executionMessage }),
        programAddress: MESSAGE_EXECUTOR_PROGRAM_ADDRESS,
    };
}

/** The all-zero hash the authorization message carries in its blockhash slot. */
const NO_LIFETIME = '11111111111111111111111111111111' as Blockhash;

/**
 * Builds the execution message: the action, as the PDA would send it.
 *
 * The PDA is the fee payer and signer, which it could never be in a real
 * transaction; the executor fills those roles by CPI. The blockhash slot holds
 * the nonce value instead of a blockhash, and no transaction config is set
 * because the message is never executed at the top level.
 */
export function executionMessage(pda: Address, instructions: Instruction[], nonce: Address): ReadonlyUint8Array {
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(pda, m),
        // The nonce is a 32-byte value in the same encoding as a blockhash; the
        // height is never checked because the message is never sent.
        m =>
            setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: nonce as string as Blockhash, lastValidBlockHeight: 0n },
                m,
            ),
        m => appendTransactionMessageInstructions(instructions, m),
    );
    return getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
}

/**
 * Builds the authorization message that `authorities` sign.
 *
 * It is a v1 message holding exactly one instruction, `Execute`, whose data
 * carries the execution message. Its required signers are the authorities, so
 * signing it with an ordinary ed25519 key is signing a Solana message, which
 * hardware wallets and custody systems can at least ingest. It has no
 * blockhash and no transaction config.
 *
 * Laid out by hand to mirror `authorization_message` in the Anza signer client,
 * byte for byte: the kit compiler would order the accounts differently, and
 * the `Execute` instruction's own signer flags must not become required
 * signatures. Signer privilege comes only from the authorities' signatures
 * and the PDA promotion the Signer program performs.
 *
 * ```text
 * staticAccounts                   privileges
 * ┌──────────────────────────────┬─────────────────┐
 * │ authorities the executor     │ writable signer │
 * │ writes to (at least 1)       │                 │
 * ├──────────────────────────────┼─────────────────┤
 * │ remaining authorities        │ readonly signer │
 * ├──────────────────────────────┼─────────────────┤
 * │ executor writable accounts   │ writable        │
 * ├──────────────────────────────┼─────────────────┤
 * │ executor program id          │ readonly        │
 * ├──────────────────────────────┼─────────────────┤
 * │ executor readonly accounts   │ readonly        │
 * └──────────────────────────────┴─────────────────┘
 * ```
 */
export function authorizationMessage(
    executionMessage: ReadonlyUint8Array,
    nonceAccount: Address,
    nonceAuthority: Address,
    authorities: Address[],
): ReadonlyUint8Array {
    const execute = executeInstruction(executionMessage, nonceAccount, nonceAuthority);
    const accounts = execute.accounts ?? [];
    const isAuthority = (address: Address) => authorities.includes(address);
    const writesTo = (address: Address) => accounts.some(meta => meta.address === address && isWritableRole(meta.role));

    // Authorities the executor writes to must land in the header's
    // writable-signer range, so they are ordered ahead of the readonly ones.
    const writableAuthorities = authorities.filter(writesTo);
    const readonlyAuthorities = authorities.filter(address => !writesTo(address));
    // Every message needs one writable signer, the fee payer. The message pays
    // nothing, so when the executor writes to no authority the first one
    // carries the flag anyway; it grants nothing a CPI could use.
    const writableSignersCount = Math.max(writableAuthorities.length, 1);

    const writableUnsigned: Address[] = [];
    const readonlyUnsigned: Address[] = [];
    for (const meta of accounts) {
        if (isAuthority(meta.address) || meta.address === execute.programAddress) {
            continue;
        }
        const list = isWritableRole(meta.role) ? writableUnsigned : readonlyUnsigned;
        if (!list.includes(meta.address)) {
            list.push(meta.address);
        }
    }
    // A writable occurrence wins over any readonly occurrences.
    const readonlyOnly = readonlyUnsigned.filter(address => !writableUnsigned.includes(address));

    const staticAccounts = [
        ...writableAuthorities,
        ...readonlyAuthorities,
        ...writableUnsigned,
        execute.programAddress,
        ...readonlyOnly,
    ];
    const indexOf = (address: Address) => staticAccounts.indexOf(address);

    const compiled: V1CompiledTransactionMessage & { lifetimeToken: Blockhash } = {
        configMask: 0,
        configValues: [],
        header: {
            numReadonlyNonSignerAccounts: readonlyOnly.length + 1,
            numReadonlySignerAccounts: Math.max(authorities.length - writableSignersCount, 0),
            numSignerAccounts: authorities.length,
        },
        instructionHeaders: [
            {
                numInstructionAccounts: accounts.length,
                numInstructionDataBytes: execute.data?.length ?? 0,
                programAccountIndex: indexOf(execute.programAddress),
            },
        ],
        instructionPayloads: [
            {
                instructionAccountIndices: accounts.map(meta => indexOf(meta.address)),
                instructionData: execute.data ?? new Uint8Array(),
            },
        ],
        lifetimeToken: NO_LIFETIME,
        numInstructions: 1,
        numStaticAccounts: staticAccounts.length,
        staticAccounts,
        version: 1,
    };
    return getCompiledTransactionMessageEncoder().encode(compiled);
}

/**
 * Signs the authorization message with a cold key.
 *
 * This is the only thing the cold key ever signs. It needs no RPC, no
 * blockhash, and no SOL.
 */
export async function signAuthorization(
    authorizationMessage: ReadonlyUint8Array,
    authority: KeyPairSigner,
): Promise<SignatureBytes> {
    return await signBytes(authority.keyPair.privateKey, authorizationMessage);
}

/**
 * What crosses from the cold side to the hot side: everything the relayer
 * needs and nothing it can alter without invalidating the signature.
 */
export type Artifact = {
    /** The authorization message, base64, exactly as signed. */
    authorizationMessage: string;
    /** One signature per authority, as `address=signature` pairs. */
    signatures: string[];
    /** The nonce value the execution consumes. */
    consumedNonce: Address;
    /** The nonce value the account will hold afterwards. */
    nextNonce: Address;
};

export function artifact(
    authorizationMessage: ReadonlyUint8Array,
    signatures: [Address, SignatureBytes][],
    consumedNonce: Address,
    nextNonce: Address,
): Artifact {
    return {
        authorizationMessage: getBase64Decoder().decode(authorizationMessage),
        consumedNonce,
        nextNonce,
        signatures: signatures.map(([address, signature]) => `${address}=${getBase58Decoder().decode(signature)}`),
    };
}

/** A signed relay transaction, ready to send. */
export type RelayTransaction = SendableTransaction & Transaction & TransactionWithBlockhashLifetime;

/**
 * Builds and signs the relay transaction: a normal v1 transaction from
 * `relayer` holding one `Submit` instruction, signed by the relayer alone.
 *
 * The authorities' signatures travel inside the instruction data. The relayer
 * supplies the blockhash, pays the fee, and sets the compute budget; it cannot
 * change what the authorities approved.
 */
export async function relayTransaction(
    clients: Clients,
    authorizationMessage: ReadonlyUint8Array,
    signatures: SignatureBytes[],
    relayer: KeyPairSigner,
): Promise<RelayTransaction> {
    const submit = getSubmitInstruction({ message: authorizationMessage, signatures });
    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayerSigner(relayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m => appendTransactionMessageInstruction(submit, m),
        m => setTransactionMessageConfig(RELAY_CONFIG, m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(transaction);
    return transaction;
}

/** Sends a relay transaction and waits for it to confirm. */
export async function sendRelay(clients: Clients, transaction: RelayTransaction): Promise<Signature> {
    await sendAndConfirmTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
}

/** The addresses whose signatures a compiled transaction carries. */
export function signersOf(transaction: Transaction): Address[] {
    return Object.keys(transaction.signatures) as Address[];
}
