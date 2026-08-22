/**
 * Sends a transaction v1 transfer whose lifetime comes from a durable nonce.
 *
 * A durable nonce replaces the recent blockhash with a value stored in an
 * on-chain account, so the transaction stays valid until that nonce advances
 * rather than expiring after ~150 slots. Nothing about that mechanism changes
 * on v1: the nonce still travels in the message's blockhash slot, and the
 * compute budget still travels in the v1 config alongside it.
 *
 * Run with `just ts-nonce`.
 */

import {
    fetchNonce,
    getCreateAccountInstruction,
    getInitializeNonceAccountInstruction,
    getNonceSize,
    getTransferSolInstruction,
    SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import {
    airdropFactory,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructions,
    areV1ConfigsEqual,
    assertIsTransactionWithBlockhashLifetime,
    assertIsTransactionWithDurableNonceLifetime,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64Encoder,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    lamports,
    type Nonce,
    pipe,
    sendAndConfirmDurableNonceTransactionFactory,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLifetimeUsingDurableNonce,
    signTransactionMessageWithSigners,
} from '@solana/kit';

import { assertV1Active } from './lib/feature';
import { formatTransactionConfig, json } from './lib/rpc';
import { createClients, sendAndConfirm } from './lib/send';
import { decodeTransactionVersion, EXAMPLE_CONFIG } from './lib/v1';

const decodeBase64 = (encoded: string) => decodeTransactionVersion(getBase64Encoder().encode(encoded));

const clients = createClients();

await assertV1Active(clients.rpc);

const payer = await generateKeyPairSigner();
const nonceAccount = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
await airdropFactory(clients)({
    commitment: 'confirmed',
    lamports: lamports(1_000_000_000n),
    recipientAddress: payer.address,
});

// Creating a nonce
const rent = await clients.rpc.getMinimumBalanceForRentExemption(BigInt(getNonceSize())).send();
const { value: setupBlockhash } = await clients.rpc.getLatestBlockhash().send();
const setupMessage = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(setupBlockhash, m),
    m =>
        appendTransactionMessageInstructions(
            [
                getCreateAccountInstruction({
                    lamports: rent,
                    newAccount: nonceAccount,
                    payer,
                    programAddress: SYSTEM_PROGRAM_ADDRESS,
                    space: BigInt(getNonceSize()),
                }),
                getInitializeNonceAccountInstruction({
                    nonceAccount: nonceAccount.address,
                    nonceAuthority: payer.address,
                }),
            ],
            m,
        ),
    m => setTransactionMessageConfig({ computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 64 * 1024 }, m),
);
const setupTransaction = await signTransactionMessageWithSigners(setupMessage);
assertIsTransactionWithBlockhashLifetime(setupTransaction);
await sendAndConfirm(clients, setupTransaction);
console.log(`== nonce account created ==\n  address: ${nonceAccount.address}`);

// Fetch nonce
const { data: nonceState } = await fetchNonce(clients.rpc, nonceAccount.address, { commitment: 'confirmed' });
const nonce = nonceState.blockhash as unknown as Nonce;
console.log(`  nonce:   ${nonce}`);

// Use nonce in a v1 tranaction
const message = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayerSigner(payer, m),
    m =>
        setTransactionMessageLifetimeUsingDurableNonce(
            { nonce, nonceAccountAddress: nonceAccount.address, nonceAuthorityAddress: payer.address },
            m,
        ),
    m =>
        appendTransactionMessageInstruction(
            getTransferSolInstruction({ amount: lamports(10_000_000n), destination: recipient.address, source: payer }),
            m,
        ),
    m => setTransactionMessageConfig(EXAMPLE_CONFIG, m),
);

const transaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithDurableNonceLifetime(transaction);

const local = decodeBase64(getBase64EncodedWireTransaction(transaction));
console.log('\n== compiled locally ==');
console.log(`  version:      ${local.version}`);
console.log(`  config:       ${json(local.config)}`);
console.log(`  instructions: ${message.instructions.length} (AdvanceNonceAccount, then the transfer)`);

await sendAndConfirmDurableNonceTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
const signature = getSignatureFromTransaction(transaction);
console.log(`\n== sent ==\n  signature: ${signature}`);

const fetched = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
if (fetched === null) {
    throw new Error('the transaction just sent was not found');
}

console.log('\n== read back over JSON-RPC ==');
console.log(`  version:         ${fetched.version}`);
console.log(`  recentBlockhash: ${fetched.transaction.message.recentBlockhash} (the nonce, not a blockhash)`);
console.log(formatTransactionConfig(fetched.transaction.message.transactionConfig));

const encoded = await clients.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 1 })
    .send();
if (encoded === null) {
    throw new Error('the transaction just sent was not found');
}

const remote = decodeBase64(encoded.transaction[0]);
if (local.config === undefined || remote.config === undefined || !areV1ConfigsEqual(local.config, remote.config)) {
    throw new Error('the config did not survive the round trip');
}
console.log('  config round-tripped exactly');

// Nonce after advancing should be different
const { data: advanced } = await fetchNonce(clients.rpc, nonceAccount.address, { commitment: 'confirmed' });
console.log('\n== nonce after the transaction ==');
console.log(`  before: ${nonce}`);
console.log(`  after:  ${advanced.blockhash}`);
if ((advanced.blockhash as string) === (nonce as string)) {
    throw new Error('the nonce did not advance');
}
