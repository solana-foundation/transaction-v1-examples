/**
 * Signs a SOL transfer with a cold key that never goes online, then relays it
 * after the blockhash that was current at signing time has expired.
 *
 * The same transfer is sent twice. First as a System durable nonce
 * transaction, the flow being replaced. Then as a programmatic signer
 * authorization: the cold key signs an authorization message, a hot relayer
 * wraps it in a transaction with a fresh blockhash, and the PDA that acts for
 * the cold key pays. Afterwards the nonce has advanced to the value predicted
 * at signing time, and relaying the same artifact again is rejected.
 *
 * Run with `just ts-sign-relay`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    appendTransactionMessageInstruction,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    generateKeyPairSigner,
    getCompiledTransactionMessageDecoder,
    getTransactionSize,
    isSolanaError,
    lamports,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from '@solana/kit';

import { assertProgramsDeployed, fundedSigner, waitForBlockhashExpiry } from './lib/cluster';
import {
    createSystemNonceAccount,
    fetchSystemNonce,
    sendDurableNonceTransaction,
    signDurableNonceTransfer,
} from './lib/legacy';
import { createNonceAccount, fetchNonce, nextNonce } from './lib/nonce';
import { createClients, json } from './lib/rpc';
import {
    artifact,
    authorizationMessage,
    executionMessage,
    programmaticSigner,
    relayTransaction,
    sendRelay,
    signAuthorization,
    signersOf,
    transferFromPda,
} from './lib/signer';

const AMOUNT = 10_000_000n;

const clients = createClients();

await assertProgramsDeployed(clients.rpc);

const relayer = await fundedSigner(clients, 2_000_000_000n);
const recipient = (await generateKeyPairSigner()).address;

// The flow being replaced. The cold key holds the funds and pays the fee, so
// it has to be funded, and it signs a whole transaction.
console.log('== before: a System durable nonce transaction ==');
const cold = await fundedSigner(clients, 1_000_000_000n);
const systemNonceAccount = await createSystemNonceAccount(clients, cold);
const systemNonce = await fetchSystemNonce(clients.rpc, systemNonceAccount);
const durable = await signDurableNonceTransfer(cold, systemNonceAccount, systemNonce, recipient, AMOUNT);
console.log(`  nonce account: ${systemNonceAccount}`);
console.log(`  nonce:         ${systemNonce}`);
console.log(`  signed by:     ${json(signersOf(durable))} (the cold key, which also pays)`);
console.log(`  size:          ${getTransactionSize(durable)} bytes`);
console.log(`  landed:        ${await sendDurableNonceTransaction(clients, durable)}`);
console.log(
    `  nonce after:   ${await fetchSystemNonce(clients.rpc, systemNonceAccount)} (a future blockhash; not knowable at signing time)`,
);

// The replacement. The cold key is never funded and never signs a transaction.
// A PDA derived from it holds the funds instead.
console.log('\n== after: a programmatic signer authorization ==');
const authority = await generateKeyPairSigner();
const pda = await programmaticSigner(authority.address);
console.log(`  authority: ${authority.address} (cold; holds nothing, signs one message)`);
console.log(`  pda:       ${pda} (holds the funds; nothing to create)`);

// Fund the PDA. It is a plain System-owned address, so this is an ordinary
// transfer; in a migration it is where the cold key's SOL moves to.
{
    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const fund = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 'legacy' }),
            m => setTransactionMessageFeePayerSigner(relayer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
            m =>
                appendTransactionMessageInstruction(
                    getTransferSolInstruction({ amount: lamports(1_000_000_000n), destination: pda, source: relayer }),
                    m,
                ),
        ),
    );
    assertIsTransactionWithBlockhashLifetime(fund);
    await sendAndConfirmTransactionFactory(clients)(fund, { commitment: 'confirmed' });
}

// One SPL nonce account per action in flight. The relayer pays the rent; the
// PDA is the authority, so only an authorization can consume it.
const nonceAccount = await createNonceAccount(clients, relayer, pda);
const { nonce } = await fetchNonce(clients.rpc, nonceAccount);
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold side. Nothing below needs an RPC: the execution message, the
// authorization message, and the signature can all be produced air-gapped
// once the nonce value is known.
console.log('\n== signed on the cold side ==');
const transfer = transferFromPda(pda, recipient, AMOUNT);
const execution = executionMessage(pda, [transfer], nonce);
const authorization = authorizationMessage(execution, nonceAccount, pda, [authority.address]);
const signature = await signAuthorization(authorization, authority);
const predicted = await nextNonce(nonceAccount, nonce, execution);
const signed = artifact(authorization, [[authority.address, signature]], nonce, predicted);
const decodedAuthorization = getCompiledTransactionMessageDecoder().decode(authorization);
if (decodedAuthorization.version !== 1) {
    throw new Error('the authorization message must be v1');
}
console.log(`  execution message:     ${execution.length} bytes, 1 instruction (the transfer)`);
console.log(`  authorization message: ${authorization.length} bytes, 1 instruction (Execute, wrapping it)`);
console.log(
    `  signers:               ${json(decodedAuthorization.staticAccounts.slice(0, decodedAuthorization.header.numSignerAccounts))}`,
);
console.log(`  artifact:              ${json(signed, 2).replace(/\n/g, '\n                         ')}`);

// A transaction signed now would die with this blockhash. The artifact has no
// blockhash, so it does not.
const { value: blockhashAtSigning } = await clients.rpc.getLatestBlockhash().send();
if (process.env.PSIGNER_SKIP_EXPIRY) {
    console.log(`\n== skipping the wait for blockhash ${blockhashAtSigning.blockhash} to expire ==`);
} else {
    console.log(`\n== waiting for blockhash ${blockhashAtSigning.blockhash} to expire (about a minute) ==`);
    await waitForBlockhashExpiry(clients.rpc, blockhashAtSigning.blockhash);
    console.log('  expired; a transaction signed alongside the artifact would now be dropped');
}

// The hot side. Any funded key can relay; it learns nothing it can change.
console.log('\n== relayed ==');
const relay = await relayTransaction(clients, authorization, [signature], relayer);
const relaySigners = signersOf(relay);
if (relaySigners.includes(authority.address)) {
    throw new Error('the authority must not sign the relay transaction');
}
console.log(
    `  relay transaction: ${getTransactionSize(relay)} bytes, v1, signed by ${json(relaySigners)} (the relayer)`,
);
const relaySignature = await sendRelay(clients, relay);
console.log(`  landed:            ${relaySignature}`);
const fetched = await clients.rpc
    .getTransaction(relaySignature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
console.log(`  compute units:     ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const { value: balance } = await clients.rpc.getBalance(recipient, { commitment: 'confirmed' }).send();
console.log(`  recipient balance: ${balance} lamports (both transfers)`);
if (balance !== 2n * AMOUNT) {
    throw new Error(`expected the recipient to hold ${2n * AMOUNT} lamports`);
}
const { nonce: advanced } = await fetchNonce(clients.rpc, nonceAccount);
console.log(`  nonce after:       ${advanced}`);
console.log(`  predicted:         ${predicted}`);
if (advanced !== predicted) {
    throw new Error('the nonce did not advance to the value predicted at signing time');
}

// The nonce value the artifact names is gone, so the executor refuses it.
// Error 3 is the Executor's NonceMismatch, surfaced through the Signer.
console.log('\n== relayed again ==');
const replay = await relayTransaction(clients, authorization, [signature], relayer);
try {
    await sendRelay(clients, replay);
    throw new Error('the replay unexpectedly landed');
} catch (error) {
    if (!isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
        throw error;
    }
    const cause = error.cause;
    console.log(
        `  rejected: ${error.message.split('\n')[0]} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
    if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) || cause.context.code !== 3) {
        throw new Error("expected the executor's NonceMismatch (custom program error 3)", { cause: error });
    }
}
