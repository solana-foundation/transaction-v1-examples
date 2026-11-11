/**
 * Signs a token withdrawal with a cold key that never goes online, then
 * relays it from a hot key: the PDA moves 250 of a Token program mint, the
 * kind USDC is, to a recipient whose token account does not exist yet and
 * creates that account on the way.
 *
 * Run with `just ts-token-transfer`.
 */

import { findProgrammaticSignerPda } from '@solana-program/ed25519-programmatic-signer';
import { getTransferToATAInstructionPlanAsync } from '@solana-program/token';
import { type Address, createNoopSigner, generateKeyPairSigner, lamports, signBytes } from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';
import { associatedTokenAddress, DECIMALS, uiAmount } from './lib/token';

/** 1,000 tokens at six decimals: what the PDA holds. */
const SUPPLY = 1_000_000_000n;
/** 250 tokens: what the withdrawal moves. */
const AMOUNT = 250_000_000n;

const relayer = await createFundedClient(5_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
const recipient = (await generateKeyPairSigner()).address;

console.log('== setup: the PDA holds 1,000 tokens ==');
console.log(`  authority: ${authority.address} (cold)`);
console.log(`  pda:       ${pda} (owns the token account)`);
// The PDA pays the rent of the token account it creates for the recipient, so
// it needs some SOL as well as tokens.
await relayer.system.instructions
    .transferSol({ amount: lamports(100_000_000n), destination: pda, source: relayer.payer })
    .sendTransaction();
const newMint = await generateKeyPairSigner();
const mint = newMint.address;
await relayer.token.instructions
    .createMint({ decimals: DECIMALS, mintAuthority: relayer.payer.address, newMint })
    .sendTransactions();
await relayer.token.instructions
    .mintToATA({ amount: SUPPLY, decimals: DECIMALS, mint, mintAuthority: relayer.payer, owner: pda })
    .sendTransactions();
const pdaAccount = await associatedTokenAddress(pda, mint);
const balance = async (account: Address) => (await relayer.token.accounts.token.fetch(account)).data.amount;
console.log(`  mint:        ${mint}`);
console.log(`  PDA account: ${pdaAccount} holds ${uiAmount(await balance(pdaAccount))}`);
console.log(`  recipient:   ${recipient} (no token account yet; the PDA creates it)`);
const nonceAccount = await createNonceAccount(relayer, pda);
const { nonce } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold side: `transferToATA` from the token client, with the PDA as payer
// and owner (a noop signer names it, since it has no key), compiled into an execution message, wrapped in an authorization
// message, and signed. Nothing here needs an RPC.
console.log('\n== signed on the cold side ==');
const pdaSigner = createNoopSigner(pda);
const withdrawal = await getTransferToATAInstructionPlanAsync({
    amount: AMOUNT,
    authority: pdaSigner,
    decimals: DECIMALS,
    mint,
    payer: pdaSigner,
    recipient,
});
const execution = executionMessage(pda, withdrawal, nonce);
const authorization = authorizationMessage(execution, nonceAccount, pda, authority.address);
const signature = await signBytes(authority.keyPair.privateKey, authorization);
const predicted = await nextNonce(nonceAccount, nonce, execution);
console.log(
    `  execution message:     ${execution.length} bytes, 2 instructions (CreateAssociatedTokenAccountIdempotent, TransferChecked)`,
);
console.log(`  authorization message: ${authorization.length} bytes`);

console.log('\n== relayed ==');
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({ message: authorization, signatures: [signature] })
    .sendTransaction();
console.log(`  landed:        ${relay.signature}`);
const fetched = await relayer.rpc
    .getTransaction(relay.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
console.log(`  compute units: ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const recipientAccount = await associatedTokenAddress(recipient, mint);
const received = await balance(recipientAccount);
console.log(
    `  recipient account: ${recipientAccount} holds ${uiAmount(received)} (created by the PDA, which paid its rent)`,
);
if (received !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT}`);
}
const left = await balance(pdaAccount);
console.log(`  PDA account:       holds ${uiAmount(left)}`);
if (left !== SUPPLY - AMOUNT) {
    throw new Error(`expected the PDA to hold ${SUPPLY - AMOUNT}`);
}
const { nonce: advanced } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
console.log(`  nonce after:       ${advanced}`);
console.log(`  predicted:         ${predicted}`);
if (advanced !== predicted) {
    throw new Error('the nonce did not advance to the value predicted at signing time');
}
