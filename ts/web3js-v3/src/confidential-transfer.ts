// Run with `just w3v3-confidential-transfer` while a validator is up (`just validator-start`).

import { fetchMint, fetchToken } from '@solana-program/token-2022';
import { getConfidentialTransferInstructionPlan } from '@solana-program/token-2022/confidential';
import { Keypair, MessageV1 } from '@solana/web3.js';

import {
    applyPendingBalance,
    createConfidentialContext,
    createConfidentialMint,
    createConfidentialParty,
    fetchPartyBalance,
    fundConfidentially,
    MINT_DECIMALS,
    send,
} from './lib/confidential';
import { json } from './lib/v1';

const STARTING_BALANCE = 10_000n;
const TRANSFER_AMOUNT = 2_500n;
const AIRDROP_LAMPORTS = 20_000_000_000;

const units = (amount: bigint) => (Number(amount) / 10 ** MINT_DECIMALS).toFixed(MINT_DECIMALS);

const context = await createConfidentialContext(AIRDROP_LAMPORTS);
const sender = context.payer;
const recipient = await Keypair.generate();

const mint = await createConfidentialMint(context);
const senderParty = await createConfidentialParty(context, mint, sender);
const recipientParty = await createConfidentialParty(context, mint, recipient);
await fundConfidentially(context, mint, senderParty, STARTING_BALANCE);

console.log('== setup ==');
console.log(`  mint:              ${mint}`);
console.log(`  sender token:      ${senderParty.token}`);
console.log(`  recipient token:   ${recipientParty.token}`);
console.log(`  sender available:  ${units((await fetchPartyBalance(context, senderParty)).availableBalance)}`);

const [mintAccount, sourceAccount, destinationAccount] = await Promise.all([
    fetchMint(context.rpc, mint),
    fetchToken(context.rpc, senderParty.token),
    fetchToken(context.rpc, recipientParty.token),
]);
const transferPlan = await getConfidentialTransferInstructionPlan({
    aesKey: senderParty.aesKey,
    amount: TRANSFER_AMOUNT,
    authority: senderParty.owner,
    destinationToken: recipientParty.token,
    destinationTokenAccount: destinationAccount.data,
    mint,
    mintAccount: mintAccount.data,
    payer: context.payer,
    rpc: context.rpc,
    sourceElgamalKeypair: senderParty.elgamalKeypair,
    sourceToken: senderParty.token,
    sourceTokenAccount: sourceAccount.data,
});

const { signature, transaction } = await send(context, transferPlan);

console.log('\n== packed as one v1 transaction ==');
console.log(`  instructions:  ${transaction.message.compiledInstructions.length}`);
console.log(`  size:          ${transaction.serialize().length} of 4096 bytes`);

const sent = await context.connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });
if (sent === null) {
    throw new Error('the transaction just sent was not found');
}

console.log('\n== sent ==');
console.log(`  signature:       ${signature}`);
console.log(`  version:         ${sent.version}`);
console.log(`  compute units:   ${sent.meta?.computeUnitsConsumed} consumed`);
const { message } = sent.transaction;
console.log(`  config:          ${message instanceof MessageV1 ? json(message.transactionConfig) : 'none'}`);

await applyPendingBalance(context, recipientParty);

const [senderBalance, recipientBalance] = await Promise.all([
    fetchPartyBalance(context, senderParty),
    fetchPartyBalance(context, recipientParty),
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
