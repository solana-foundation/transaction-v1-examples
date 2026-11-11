/** Connecting with a funded key, checking the programs are deployed, and waiting out a blockhash. */

import {
    ED25519_SIGNER_PROGRAM_ADDRESS,
    ed25519SignerProgram,
    MESSAGE_EXECUTOR_PROGRAM_ADDRESS,
    NONCE_PROGRAM_ADDRESS,
    nonceProgram,
} from '@solana-program/ed25519-programmatic-signer';
import { systemProgram } from '@solana-program/system';
import { tokenProgram } from '@solana-program/token';
import { type Blockhash, createClient, fetchEncodedAccount, lamports } from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
export const DEFAULT_RPC_SUBSCRIPTIONS_URL = 'ws://127.0.0.1:8900';

/**
 * A `@solana/kit` plugin client for a freshly generated key funded by airdrop.
 *
 * `solanaLocalRpc` connects to the endpoints named by `PSIGNER_RPC_URL` and
 * `PSIGNER_RPC_SUBSCRIPTIONS_URL` and installs transaction planning and
 * sending: every transaction the client sends is v1, paid by `client.payer`,
 * with resource limits measured by simulation. The program plugins hang typed
 * instruction builders and account fetchers off the client, and each builder
 * can send itself.
 */
export async function createFundedClient(amount: bigint) {
    return (
        await createClient()
            .use(generatedSigner())
            .use(
                solanaLocalRpc({
                    rpcSubscriptionsUrl: process.env.PSIGNER_RPC_SUBSCRIPTIONS_URL ?? DEFAULT_RPC_SUBSCRIPTIONS_URL,
                    rpcUrl: process.env.PSIGNER_RPC_URL ?? DEFAULT_RPC_URL,
                }),
            )
            .use(airdropSigner(lamports(amount)))
    )
        .use(systemProgram())
        .use(tokenProgram())
        .use(nonceProgram())
        .use(ed25519SignerProgram());
}

export type Client = Awaited<ReturnType<typeof createFundedClient>>;

/** The three programs the examples call, with the names their crates use. */
export const PROGRAMS = [
    ['SPL Nonce', NONCE_PROGRAM_ADDRESS],
    ['SPL Ed25519 Signer', ED25519_SIGNER_PROGRAM_ADDRESS],
    ['SPL Message Executor', MESSAGE_EXECUTOR_PROGRAM_ADDRESS],
] as const;

/**
 * Throws unless all three programs are deployed on the cluster behind `rpc`.
 *
 * Checked up front so a validator started without them names itself, rather
 * than surfacing later as a `ProgramAccountNotFound` on the relay.
 */
export async function assertProgramsDeployed(rpc: Client['rpc']): Promise<void> {
    for (const [name, programAddress] of PROGRAMS) {
        const account = await fetchEncodedAccount(rpc, programAddress);
        if (!account.exists || !account.executable) {
            throw new Error(
                `the ${name} program (${programAddress}) is not deployed on this cluster; start a validator with \`just validator-start\``,
            );
        }
    }
}

/**
 * Resolves once `blockhash` can no longer be used in a transaction.
 *
 * A blockhash lives for 150 slots, about a minute on a local validator. The
 * examples capture one when the cold key signs and wait it out before
 * relaying, which is the shortest demonstration that the signed artifact does
 * not expire with it.
 */
export async function waitForBlockhashExpiry(rpc: Client['rpc'], blockhash: Blockhash): Promise<void> {
    for (;;) {
        const { value: valid } = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send();
        if (!valid) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
}
