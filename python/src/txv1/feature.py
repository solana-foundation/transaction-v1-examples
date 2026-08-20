"""Checking whether transaction v1 is live on a cluster."""

from __future__ import annotations

import base64

from txv1.rpc import RpcClient

# The feature gate that activates transaction v1.
ENABLE_TX_V1_FEATURE = "txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL"


def is_v1_active(client: RpcClient, feature_address: str = ENABLE_TX_V1_FEATURE) -> bool:
    """Reports whether ``enable_tx_v1`` is activated on the cluster behind ``client``.

    An absent account and a staged-but-inactive one both mean a v1 transaction
    would be rejected, so both answer ``False``.

    A feature account holds a bincode ``Option<u64>``: a one-byte tag, ``0``
    until the gate activates, then ``1`` followed by the slot it activated at.
    """
    account = client.get_account_info(feature_address)
    if account is None:
        return False
    data = base64.b64decode(account["data"][0])
    return len(data) > 0 and data[0] == 1


def assert_v1_active(client: RpcClient) -> None:
    """Raises unless ``enable_tx_v1`` is activated on the cluster behind ``client``.

    Checked up front so an inactive gate names itself, rather than surfacing as
    a rejected transaction whose error says nothing about the version.
    """
    if not is_v1_active(client):
        raise RuntimeError(
            f"enable_tx_v1 ({ENABLE_TX_V1_FEATURE}) is not activated on this cluster; "
            "a v1 transaction would be rejected"
        )
