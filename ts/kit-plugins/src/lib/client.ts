/**
 * The `@solana/kit` plugin client the examples in this package are built on.
 *
 * `systemProgram` and `token2022Program` are program plugins: they hang a typed
 * instruction builder and account fetcher for their program off the client, and
 * every builder they add can plan and send itself. They go on last because they
 * need the transaction planning and sending that `solanaLocalRpc` installs.
 */

import { systemProgram } from '@solana-program/system';
import { token2022Program } from '@solana-program/token-2022';
import { createClient, lamports } from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';

const PRIORITY_FEE_LAMPORTS = lamports(5_000n);

export async function createV1Client(airdrop: bigint) {
    return (
        await createClient()
            .use(generatedSigner())
            .use(
                solanaLocalRpc({
                    rpcSubscriptionsUrl: process.env.TXV1_RPC_SUBSCRIPTIONS_URL ?? 'ws://127.0.0.1:8900',
                    rpcUrl: process.env.TXV1_RPC_URL ?? 'http://127.0.0.1:8899',
                    transactionConfig: { priorityFeeLamports: PRIORITY_FEE_LAMPORTS, version: 1 },
                }),
            )
            .use(airdropSigner(lamports(airdrop)))
    )
        .use(systemProgram())
        .use(token2022Program());
}

export type V1Client = Awaited<ReturnType<typeof createV1Client>>;
