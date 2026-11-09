/**
 * Signs a token withdrawal with a cold key that never goes online, then
 * relays it from a hot key: the PDA moves 250 of a Token program mint, the
 * kind USDC is, to a recipient whose token account does not exist yet and
 * creates that account on the way.
 *
 * Run with `just ts-token-transfer`.
 */

import { getTransferSolInstruction } from '@solana-program/system';
import { generateKeyPairSigner, lamports } from '@solana/kit';

import { assertProgramsDeployed, fundedSigner, sendInstructions } from './lib/cluster';
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
} from './lib/signer';
import { associatedTokenAddress, createMint, fetchBalance, mintTo, uiAmount, withdraw } from './lib/token';

/** 1,000 tokens at six decimals: what the PDA holds. */
const SUPPLY = 1_000_000_000n;
/** 250 tokens: what the withdrawal moves. */
const AMOUNT = 250_000_000n;

const clients = createClients();

await assertProgramsDeployed(clients.rpc);

const relayer = await fundedSigner(clients, 5_000_000_000n);
const authority = await generateKeyPairSigner();
const pda = await programmaticSigner(authority.address);
const recipient = (await generateKeyPairSigner()).address;

console.log('== setup: the PDA holds 1,000 tokens ==');
console.log(`  authority: ${authority.address} (cold)`);
console.log(`  pda:       ${pda} (owns the token account)`);
// The PDA pays the rent of the token account it creates for the recipient, so
// it needs some SOL as well as tokens.
await sendInstructions(clients, relayer, [
    getTransferSolInstruction({ amount: lamports(100_000_000n), destination: pda, source: relayer }),
]);
const mint = await createMint(clients, relayer);
const pdaAccount = await mintTo(clients, relayer, mint, pda, SUPPLY);
console.log(`  mint:        ${mint}`);
console.log(`  PDA account: ${pdaAccount} holds ${uiAmount(await fetchBalance(clients.rpc, pdaAccount))}`);
console.log(`  recipient:   ${recipient} (no token account yet; the PDA creates it)`);
const nonceAccount = await createNonceAccount(clients, relayer, pda);
const { nonce } = await fetchNonce(clients.rpc, nonceAccount);
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold side: two ordinary token instructions with the PDA as payer and
// owner, compiled into an execution message, wrapped in an authorization
// message, and signed. Nothing here needs an RPC.
console.log('\n== signed on the cold side ==');
const execution = executionMessage(pda, await withdraw(mint, pda, recipient, AMOUNT), nonce);
const authorization = authorizationMessage(execution, nonceAccount, pda, [authority.address]);
const signature = await signAuthorization(authorization, authority);
const predicted = await nextNonce(nonceAccount, nonce, execution);
const signed = artifact(authorization, [[authority.address, signature]], nonce, predicted);
console.log(
    `  execution message:     ${execution.length} bytes, 2 instructions (CreateAssociatedTokenAccountIdempotent, TransferChecked)`,
);
console.log(`  authorization message: ${authorization.length} bytes`);
console.log(`  artifact:              ${json(signed, 2).replace(/\n/g, '\n                         ')}`);

console.log('\n== relayed ==');
const landed = await sendRelay(clients, await relayTransaction(clients, authorization, [signature], relayer));
console.log(`  landed:        ${landed}`);
const fetched = await clients.rpc
    .getTransaction(landed, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
console.log(`  compute units: ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const recipientAccount = await associatedTokenAddress(recipient, mint);
const received = await fetchBalance(clients.rpc, recipientAccount);
console.log(
    `  recipient account: ${recipientAccount} holds ${uiAmount(received)} (created by the PDA, which paid its rent)`,
);
if (received !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT}`);
}
const left = await fetchBalance(clients.rpc, pdaAccount);
console.log(`  PDA account:       holds ${uiAmount(left)}`);
if (left !== SUPPLY - AMOUNT) {
    throw new Error(`expected the PDA to hold ${SUPPLY - AMOUNT}`);
}
const { nonce: advanced } = await fetchNonce(clients.rpc, nonceAccount);
console.log(`  nonce after:       ${advanced}`);
console.log(`  predicted:         ${predicted}`);
if (advanced !== predicted) {
    throw new Error('the nonce did not advance to the value predicted at signing time');
}
