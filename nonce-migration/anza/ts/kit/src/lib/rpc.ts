/** Endpoints and display helpers shared by the examples. */

import {
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    type Rpc,
    type RpcSubscriptions,
    type SolanaRpcApi,
    type SolanaRpcSubscriptionsApi,
} from '@solana/kit';

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
export const DEFAULT_RPC_SUBSCRIPTIONS_URL = 'ws://127.0.0.1:8900';

export type Clients = {
    rpc: Rpc<SolanaRpcApi>;
    rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

/** Connects to the endpoints named by `PSIGNER_RPC_URL` and `PSIGNER_RPC_SUBSCRIPTIONS_URL`. */
export function createClients(): Clients {
    return {
        rpc: createSolanaRpc(process.env.PSIGNER_RPC_URL ?? DEFAULT_RPC_URL),
        rpcSubscriptions: createSolanaRpcSubscriptions(
            process.env.PSIGNER_RPC_SUBSCRIPTIONS_URL ?? DEFAULT_RPC_SUBSCRIPTIONS_URL,
        ),
    };
}

/** Serializes a value that may contain bigints. */
export const json = (value: unknown, indent?: number) =>
    JSON.stringify(value, (_, entry) => (typeof entry === 'bigint' ? `${entry}` : entry), indent);
