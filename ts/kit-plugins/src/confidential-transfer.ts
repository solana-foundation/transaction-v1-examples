/**
 * Performs a full Token-2022 confidential transfer in a single v1 transaction,
 * driven by a `@solana/kit` plugin client.
 *
 * This is `ts/kit/src/confidential-transfer.ts` with the message building, the
 * resource limit estimation, the signing, and the sending handed to the client.
 * The three proofs, the transfer that reads them, and the cleanup that reclaims
 * their rent still land in one message, and `sendTransaction` is what asserts it:
 * it plans a single transaction and fails if the plan needs more than one.
 *
 * Run with `just kp-confidential-transfer` while validator is running `just validator-start`
 *
 * More on Confidential Transfers: https://solana.com/docs/tokens/extensions/confidential-transfer
 */

import { fetchMint, fetchToken } from '@solana-program/token-2022';
import { getConfidentialTransferInstructionPlan } from '@solana-program/token-2022/confidential';
import { generateKeyPairSigner, getTransactionMessageSize, getTransactionMessageSizeLimit } from '@solana/kit';

import { createV1Client } from './lib/client';
import {
    applyPendingBalance,
    createConfidentialMint,
    createConfidentialParty,
    fetchPartyBalance,
    fundConfidentially,
    MINT_DECIMALS,
} from './lib/confidential';
import { decodeBase64Transaction, json } from './lib/v1';

const STARTING_BALANCE = 10_000n;
const TRANSFER_AMOUNT = 2_500n;

const units = (amount: bigint) => (Number(amount) / 10 ** MINT_DECIMALS).toFixed(MINT_DECIMALS);

const client = await createV1Client(20_000_000_000n);

const sender = client.payer;
const recipient = await generateKeyPairSigner();

const mint = await createConfidentialMint(client);
const senderParty = await createConfidentialParty(client, mint, sender);
const recipientParty = await createConfidentialParty(client, mint, recipient);
await fundConfidentially(client, mint, senderParty, STARTING_BALANCE);

console.log('== setup ==');
console.log(`  mint:              ${mint}`);
console.log(`  sender token:      ${senderParty.token}`);
console.log(`  recipient token:   ${recipientParty.token}`);
console.log(`  sender available:  ${units((await fetchPartyBalance(client, senderParty)).availableBalance)}`);

const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
    fetchMint(client.rpc, mint),
    fetchToken(client.rpc, senderParty.token),
    fetchToken(client.rpc, recipientParty.token),
]);
const transferPlan = await getConfidentialTransferInstructionPlan({
    aesKey: senderParty.aesKey,
    amount: TRANSFER_AMOUNT,
    authority: senderParty.owner,
    destinationToken: recipientParty.token,
    destinationTokenAccount: destinationAccount.data,
    mint,
    mintAccount: mintAccount.data,
    payer: client.payer,
    rpc: client.rpc,
    sourceElgamalKeypair: senderParty.elgamalKeypair,
    sourceToken: senderParty.token,
    sourceTokenAccount: sourceAccount.data,
});

const message = await client.planTransaction(transferPlan);
console.log('\n== packed as one v1 transaction ==');
console.log(`  instructions:  ${message.instructions.length}`);
console.log(
    `  size:          ${getTransactionMessageSize(message)} of ${getTransactionMessageSizeLimit(message)} bytes`,
);

const { context } = await client.sendTransaction(message);

const sent = await client.rpc
    .getTransaction(context.signature, {
        commitment: 'confirmed',
        encoding: 'base64',
        maxSupportedTransactionVersion: 1,
    })
    .send();
if (sent === null) {
    throw new Error('the transaction just sent was not found');
}

console.log('\n== sent ==');
console.log(`  signature:       ${context.signature}`);
console.log(`  version:         ${sent.version}`);
console.log(`  compute units:   ${sent.meta?.computeUnitsConsumed} consumed`);
console.log(`  config:          ${json(decodeBase64Transaction(sent.transaction[0]).config)}`);

await applyPendingBalance(client, recipientParty);

const [senderBalance, recipientBalance] = await Promise.all([
    fetchPartyBalance(client, senderParty),
    fetchPartyBalance(client, recipientParty),
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
