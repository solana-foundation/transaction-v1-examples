/**
 * Performs a full Token-2022 confidential transfer in a single v1 transaction.
 *
 * The three proofs, the transfer that reads them, and the cleanup that reclaims
 * their rent all go into one message that is built, sized, signed, and sent here
 * in the open. The mint and the two configured accounts the transfer needs are
 * set up by the helpers in `lib/confidential.ts`.
 *
 * Run with `just ts-confidential-transfer` while validator is running `just validator-start`
 *
 * More on Confidential Transfers: https://solana.com/docs/tokens/extensions/confidential-transfer
 */

import { fetchMint, fetchToken } from '@solana-program/token-2022';
import { getConfidentialTransferInstructionPlan } from '@solana-program/token-2022/confidential';
import {
    airdropFactory,
    appendTransactionMessageInstructionPlan,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    generateKeyPairSigner,
    getTransactionMessageSize,
    getTransactionMessageSizeLimit,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessagePriorityFeeLamports,
    signTransactionMessageWithSigners,
} from '@solana/kit';

import {
    applyPendingBalance,
    createConfidentialMint,
    createConfidentialParty,
    fetchPartyBalance,
    fundConfidentially,
    MINT_DECIMALS,
} from './lib/confidential';
import { assertV1Active } from './lib/feature';
import { formatTransactionConfig } from './lib/rpc';
import { createClients, sendAndConfirm } from './lib/send';

const STARTING_BALANCE = 10_000n;
const TRANSFER_AMOUNT = 2_500n;
const PRIORITY_FEE_LAMPORTS = 5_000n;

const units = (amount: bigint) => (Number(amount) / 10 ** MINT_DECIMALS).toFixed(MINT_DECIMALS);

const clients = createClients();

await assertV1Active(clients.rpc);

const payer = await generateKeyPairSigner();
await airdropFactory(clients)({
    commitment: 'confirmed',
    lamports: lamports(20_000_000_000n),
    recipientAddress: payer.address,
});

const sender = payer;
const recipient = await generateKeyPairSigner();

const mint = await createConfidentialMint(clients, payer);
const senderParty = await createConfidentialParty(clients, payer, mint, sender);
const recipientParty = await createConfidentialParty(clients, payer, mint, recipient);
await fundConfidentially(clients, payer, mint, senderParty, STARTING_BALANCE);

console.log('== setup ==');
console.log(`  mint:              ${mint}`);
console.log(`  sender token:      ${senderParty.token}`);
console.log(`  recipient token:   ${recipientParty.token}`);
console.log(`  sender available:  ${units((await fetchPartyBalance(clients, senderParty)).availableBalance)}`);

const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
    fetchMint(clients.rpc, mint),
    fetchToken(clients.rpc, senderParty.token),
    fetchToken(clients.rpc, recipientParty.token),
]);
const transferPlan = await getConfidentialTransferInstructionPlan({
    aesKey: senderParty.aesKey,
    amount: TRANSFER_AMOUNT,
    authority: senderParty.owner,
    destinationToken: recipientParty.token,
    destinationTokenAccount: destinationAccount.data,
    mint,
    mintAccount: mintAccount.data,
    payer,
    rpc: clients.rpc,
    sourceElgamalKeypair: senderParty.elgamalKeypair,
    sourceToken: senderParty.token,
    sourceTokenAccount: sourceAccount.data,
});

const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
const draft = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructionPlan(transferPlan, m),
    m => setTransactionMessagePriorityFeeLamports(PRIORITY_FEE_LAMPORTS, m),
    fillTransactionMessageProvisoryResourceLimits,
);

const estimateResourceLimits = estimateResourceLimitsFactory({ rpc: clients.rpc });
const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(estimateResourceLimits);
const message = await estimateAndSetResourceLimits(draft, { commitment: 'confirmed' });

const size = getTransactionMessageSize(message);
const sizeLimit = getTransactionMessageSizeLimit(message);
if (size > sizeLimit) {
    throw new Error(`the transfer needs ${size} bytes and the limit is ${sizeLimit}`);
}

console.log('\n== packed as one v1 transaction ==');
console.log(`  instructions:  ${message.instructions.length}`);
console.log(`  size:          ${size} of ${sizeLimit} bytes`);

const transaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(transaction);
const signature = await sendAndConfirm(clients, transaction);

const sent = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
if (sent === null) {
    throw new Error('the transaction just sent was not found');
}

console.log('\n== sent ==');
console.log(`  signature:       ${signature}`);
console.log(`  version:         ${sent.version}`);
console.log(`  compute units:   ${sent.meta?.computeUnitsConsumed} consumed`);
console.log(formatTransactionConfig(sent.transaction.message.transactionConfig));

await applyPendingBalance(clients, payer, recipientParty);

const [senderBalance, recipientBalance] = await Promise.all([
    fetchPartyBalance(clients, senderParty),
    fetchPartyBalance(clients, recipientParty),
]);

console.log('\n== balances ==');
console.log(`  sender:     ${units(senderBalance.availableBalance)}`);
console.log(`  recipient:  ${units(recipientBalance.availableBalance)}`);

if (senderBalance.availableBalance !== STARTING_BALANCE - TRANSFER_AMOUNT) {
    throw new Error('the sender balance did not decrease by the transfer amount');
}
if (recipientBalance.availableBalance !== TRANSFER_AMOUNT) {
    throw new Error('the recipient balance did not increase by the transfer amount');
}
console.log('  both balances decrypted to the expected amounts');
