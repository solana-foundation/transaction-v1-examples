/**
 * Building and signing the layers of a programmatic signer action. The relayer
 * sends the outermost one with the client's `ed25519Signer` plugin.
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

import { findProgrammaticSignerPda, getExecuteInstruction } from '@solana-program/ed25519-programmatic-signer';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructionPlan,
    type Blockhash,
    compileTransactionMessage,
    createNoopSigner,
    createTransactionMessage,
    getBase58Decoder,
    getBase64Decoder,
    getCompiledTransactionMessageEncoder,
    type Instruction,
    type InstructionPlan,
    isWritableRole,
    type KeyPairSigner,
    pipe,
    type ReadonlyUint8Array,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type SignatureBytes,
    signBytes,
} from '@solana/kit';

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
