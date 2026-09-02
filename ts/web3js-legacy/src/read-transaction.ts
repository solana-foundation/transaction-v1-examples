import { getTransferSolInstruction } from '@solana-program/system';
import {
    airdropFactory,
    appendTransactionMessageInstruction,
    assertIsTransactionWithBlockhashLifetime,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    lamports,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { Connection, MessageV1 } from '@solana/web3.js';

const RPC_URL = process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899';
const RPC_SUBSCRIPTIONS_URL = process.env.TXV1_RPC_SUBSCRIPTIONS_URL ?? 'ws://127.0.0.1:8900';

async function sendV1Transfer(): Promise<string> {
    const clients = {
        rpc: createSolanaRpc(RPC_URL),
        rpcSubscriptions: createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL),
    };
    const payer = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    await airdropFactory(clients)({
        commitment: 'confirmed',
        lamports: lamports(1_000_000_000n),
        recipientAddress: payer.address,
    });

    const { value: latestBlockhash } = await clients.rpc.getLatestBlockhash().send();
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayerSigner(payer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        m =>
            appendTransactionMessageInstruction(
                getTransferSolInstruction({
                    amount: lamports(10_000_000n),
                    destination: recipient.address,
                    source: payer,
                }),
                m,
            ),
        m =>
            setTransactionMessageConfig(
                {
                    computeUnitLimit: 20_000,
                    heapSize: 64 * 1024,
                    loadedAccountsDataSizeLimit: 64 * 1024,
                    priorityFeeLamports: 5_000n,
                },
                m,
            ),
    );

    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirmTransactionFactory(clients)(transaction, { commitment: 'confirmed' });
    return getSignatureFromTransaction(transaction);
}

const describeRejection = (error: unknown) => `  rejected: ${error instanceof Error ? error.message : String(error)}`;

const signature = process.argv[2] ?? (await sendV1Transfer());
const connection = new Connection(RPC_URL, 'confirmed');
console.log(`reading ${signature}\n`);

console.log('== maxSupportedTransactionVersion omitted ==');
try {
    await connection.getTransaction(signature);
    console.log('  succeeded: this is a legacy transaction');
} catch (error) {
    console.log(describeRejection(error));
}

console.log('\n== maxSupportedTransactionVersion 0 ==');
try {
    await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    console.log('  succeeded: this is not a v1 transaction');
} catch (error) {
    console.log(describeRejection(error));
}

console.log('\n== maxSupportedTransactionVersion 1 ==');
const fetched = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });
if (fetched === null) {
    throw new Error(`transaction ${signature} was not found`);
}

const { message } = fetched.transaction;
console.log(`  version: ${message.version} (${fetched.version} in the response envelope)`);

if (message instanceof MessageV1) {
    const config = message.transactionConfig;
    console.log(`  computeUnitLimit:            ${config.computeUnitLimit ?? 'unset'}`);
    console.log(`  heapSize:                    ${config.heapSize ?? 'unset'}`);
    console.log(`  loadedAccountsDataSizeLimit: ${config.loadedAccountsDataSizeLimit ?? 'unset'}`);
    console.log(`  priorityFee:                 ${config.priorityFee ?? 'unset'} lamports`);
} else {
    console.log('  no config: not a v1 transaction');
}
