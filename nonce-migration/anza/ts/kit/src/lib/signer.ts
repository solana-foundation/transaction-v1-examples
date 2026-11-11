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

import {
    findProgrammaticSignerPda,
    getExecuteInstruction,
    getSubmitInstruction,
} from '@solana-program/ed25519-programmatic-signer';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructionPlan,
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
    type InstructionPlan,
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
    type V1TransactionConfig,
} from '@solana/kit';

import type { Clients } from './rpc';

/**
 * The address that acts for `authority`: a PDA of the Signer program.
 *
 * Nothing is created on chain. It is a plain System-owned address that holds
 * SOL and owns token accounts like any wallet, and the Signer program promotes
 * it to a signer whenever `authority` has signed an authorization for it.
 */
export async function programmaticSignerAddress(authority: Address): Promise<Address> {
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
 * A lifetime slot holding `value` instead of a blockhash. The execution
 * message carries the nonce there and the authorization message carries
 * zeros; neither is ever sent as a transaction, so the height is never read.
 */
const lifetime = (value: string) => ({ blockhash: value as Blockhash, lastValidBlockHeight: 0n });

/**
 * Builds the execution message: the action, as the PDA would send it.
 *
 * The action is an instruction plan, which is what `@solana-program/token`
 * and the other program clients hand back, so their helpers drop straight in.
 * Wherever a key would sign, name the PDA with `createNoopSigner`: it carries
 * the address and the signer role without producing a signature, and the
 * Signer program makes the role true when the action runs.
 *
 * The PDA is the fee payer and signer, which it could never be in a real
 * transaction; the executor fills those roles by CPI. The blockhash slot holds
 * the nonce value, and no transaction config is set because the message
 * never runs as a transaction of its own.
 */
export function executionMessage(pda: Address, action: InstructionPlan, nonce: Address): ReadonlyUint8Array {
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(pda, m),
        m => setTransactionMessageLifetimeUsingBlockhash(lifetime(nonce), m),
        m => appendTransactionMessageInstructionPlan(action, m),
    );
    return getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
}

/**
 * Builds the authorization message `authority` signs: a v1 message holding
 * one `Execute` instruction, with no blockhash and no transaction config.
 *
 * The authority is its only signer. Every account the instruction names is
 * demoted to a plain account first, the PDA included: the Signer program
 * grants signer privilege from the authority's signature and from PDA
 * promotion, not from the message header, and a required signer here would
 * need a signature nobody can supply. Mirrors `authorization_message` in the
 * Anza signer client crate, which has no JavaScript counterpart yet.
 */
export function authorizationMessage(
    executionMessage: ReadonlyUint8Array,
    nonceAccount: Address,
    nonceAuthority: Address,
    authority: Address,
): ReadonlyUint8Array {
    const execute = getExecuteInstruction({
        message: executionMessage,
        nonceAccount,
        nonceAuthority: createNoopSigner(nonceAuthority),
    });
    const demoted: Instruction = {
        ...execute,
        accounts: execute.accounts.map(({ address, role }) => ({
            address,
            role: isWritableRole(role) ? AccountRole.WRITABLE : AccountRole.READONLY,
        })),
    };
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(authority, m),
        m => setTransactionMessageLifetimeUsingBlockhash(lifetime('11111111111111111111111111111111'), m),
        m => appendTransactionMessageInstruction(demoted, m),
    );
    return getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
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
    /** The nonce value the action consumes. */
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
