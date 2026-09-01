/** Checking whether transaction v1 is live on a cluster. */

import { type Address, address, getBase64Encoder, getOptionDecoder, getU64Decoder, isSome } from '@solana/kit';

import type { Clients } from './send';

/**
 * The layout of a feature account: a bincode `Option<u64>` holding the slot the
 * gate activated at, `None` until it goes live.
 */
const featureDecoder = getOptionDecoder(getU64Decoder());

/** The feature gate that activates transaction v1. */
export const ENABLE_TX_V1_FEATURE = address('txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL');

/**
 * Reports whether `enable_tx_v1` is activated on the cluster behind `rpc`.
 *
 * An absent account and a staged-but-inactive one both mean a v1 transaction
 * would be rejected, so both answer `false`.
 *
 * @param rpc - Any client that can read accounts.
 * @param featureAddress - The gate to check. Defaults to {@link ENABLE_TX_V1_FEATURE}.
 */
export async function isV1Active(
    rpc: Clients['rpc'],
    featureAddress: Address = ENABLE_TX_V1_FEATURE,
): Promise<boolean> {
    const { value: account } = await rpc.getAccountInfo(featureAddress, { encoding: 'base64' }).send();
    if (account === null) {
        return false;
    }

    const [encoded] = account.data;
    return isSome(featureDecoder.decode(getBase64Encoder().encode(encoded)));
}

/**
 * Throws unless `enable_tx_v1` is activated on the cluster behind `rpc`.
 *
 * Checked up front so an inactive gate names itself, rather than surfacing as a
 * rejected transaction whose error says nothing about the version.
 */
export async function assertV1Active(rpc: Clients['rpc']): Promise<void> {
    if (!(await isV1Active(rpc))) {
        throw new Error(
            `enable_tx_v1 (${ENABLE_TX_V1_FEATURE}) is not activated on this cluster; a v1 transaction would be rejected`,
        );
    }
}
