/** The `@solana/kit` plugin client the examples in this package are built on. */

import { createClient, lamports } from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';

const PRIORITY_FEE_LAMPORTS = lamports(5_000n);

export async function createV1Client(airdrop: bigint) {
    return await createClient()
        .use(generatedSigner())
        .use(
            solanaLocalRpc({
                rpcSubscriptionsUrl: process.env.TXV1_RPC_SUBSCRIPTIONS_URL ?? 'ws://127.0.0.1:8900',
                rpcUrl: process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899',
                transactionConfig: { priorityFeeLamports: PRIORITY_FEE_LAMPORTS, version: 1 },
            }),
        )
        .use(airdropSigner(lamports(airdrop)));
}

export type V1Client = Awaited<ReturnType<typeof createV1Client>>;
