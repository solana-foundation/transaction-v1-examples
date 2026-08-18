/**
 * Sizes a v1 transaction's resource limits by simulation instead of guessing.
 *
 * On v1 the estimators write the measured limits into the config rather than
 * into ComputeBudget instructions.
 *
 * Run with `just ts-estimate`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import {
    airdropFactory,
    appendTransactionMessageInstruction,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    generateKeyPairSigner,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessagePriorityFeeLamports,
    signTransactionMessageWithSigners,
} from '@solana/kit';

import { assertV1Active } from './lib/feature';
import { json } from './lib/rpc';
import { createClients, sendAndConfirm } from './lib/send';

const clients = createClients();

await assertV1Active(clients.rpc);

const payer = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
await airdropFactory(clients)({
    commitment: 'confirmed',
    lamports: lamports(1_000_000_000n),
    recipientAddress: payer.address,
});

const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();

// The priority fee is a pricing decision, not something simulation can
// measure, so only the two resource limits are estimated below. The provisory
// fill writes placeholder limits so the message simulates at its final size.
const draft = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m =>
        appendTransactionMessageInstruction(
            getTransferSolInstruction({ amount: lamports(10_000_000n), destination: recipient.address, source: payer }),
            m,
        ),
    m => setTransactionMessagePriorityFeeLamports(5_000n, m),
    fillTransactionMessageProvisoryResourceLimits,
);

console.log('== before estimation ==');
console.log(`  config: ${json(draft.config)}`);

// Simulation runs with both limits raised to the runtime maximum, so it cannot
// fail for want of the resources it is measuring.
const estimateResourceLimits = estimateResourceLimitsFactory({ rpc: clients.rpc });
const estimate = await estimateResourceLimits(draft, { commitment: 'confirmed' });

console.log('\n== simulated ==');
console.log(`  computeUnitLimit:            ${estimate.computeUnitLimit}`);
// v1 requires this limit, so the estimator throws if the RPC withholds it; on
// legacy and v0 it is only returned when the RPC happens to report it.
console.log(`  loadedAccountsDataSizeLimit: ${estimate.loadedAccountsDataSizeLimit}`);

// Applications call one of these two (estimateResourceLimitsFactory or estimateAndSetResourceLimitsFactory),
// not both; simulating twice here shows the
// raw estimate and the message it produces side by side. The setter overwrites
// a provisory placeholder but leaves an explicitly chosen value alone.
const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(estimateResourceLimits);
const message = await estimateAndSetResourceLimits(draft, { commitment: 'confirmed' });

console.log('\n== after estimation ==');
console.log(`  config: ${json(message.config)}`);

const transaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(transaction);
const signature = await sendAndConfirm(clients, transaction);
console.log(`\n== sent ==\n  signature: ${signature}`);

const fetched = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
if (fetched === null) {
    throw new Error('the transaction just sent was not found');
}

// These two numbers are equal: the estimate is the exact cost of one simulated
// run, with nothing to spare. Kit returns the measured figure rather than
// padding it, so choosing a margin — `Math.ceil(limit * 1.1)` or similar — is
// the caller's job.
console.log('\n== consumed on chain ==');
console.log(`  computeUnitsConsumed: ${fetched.meta?.computeUnitsConsumed}`);
console.log(`  estimated limit:      ${estimate.computeUnitLimit}`);
console.log('  the limit is the measured cost exactly — add margin before doing this for real');
