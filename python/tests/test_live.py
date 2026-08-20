"""Tests that run against a live validator.

Deselected unless the `live` marker is requested, which `just test-live` does
after starting a 4.2.1 validator.
"""

from __future__ import annotations

import base64
from collections.abc import Iterator

import pytest

from txv1.feature import assert_v1_active
from txv1.rpc import BLOCK_CONFIG, RpcClient, RpcError
from txv1.send import send_v1_transfer
from txv1.v1 import EXAMPLE_CONFIG, MessageVersion, decode_transaction_version

pytestmark = pytest.mark.live


@pytest.fixture(scope="module")
def client() -> Iterator[RpcClient]:
    with RpcClient() as rpc:
        assert_v1_active(rpc)
        yield rpc


@pytest.fixture(scope="module")
def sent(client: RpcClient) -> tuple[str, int]:
    return send_v1_transfer(client)


def get_transaction(client: RpcClient, signature: str, **options: object) -> object:
    return client.call(
        "getTransaction", [signature, {"commitment": "confirmed", "encoding": "base64", **options}]
    )


def test_the_validator_returns_the_config_it_was_sent(
    client: RpcClient, sent: tuple[str, int]
) -> None:
    signature, _ = sent
    encoded = get_transaction(client, signature, maxSupportedTransactionVersion=1)
    assert isinstance(encoded, dict)

    version, config = decode_transaction_version(base64.b64decode(encoded["transaction"][0]))
    assert version is MessageVersion.V1
    assert config == EXAMPLE_CONFIG


def test_get_transaction_rejects_a_caller_pinned_below_v1(
    client: RpcClient, sent: tuple[str, int]
) -> None:
    signature, _ = sent
    with pytest.raises(RpcError):
        get_transaction(client, signature)
    with pytest.raises(RpcError):
        get_transaction(client, signature, maxSupportedTransactionVersion=0)


def test_get_block_loses_the_whole_block_below_v1(client: RpcClient, sent: tuple[str, int]) -> None:
    _, slot = sent
    with pytest.raises(RpcError):
        client.call("getBlock", [slot, {**BLOCK_CONFIG, "maxSupportedTransactionVersion": 0}])

    block = client.call("getBlock", [slot, {**BLOCK_CONFIG, "maxSupportedTransactionVersion": 1}])
    assert any(transaction.get("version") == 1 for transaction in block["transactions"])


def test_the_json_projection_reports_the_config(client: RpcClient, sent: tuple[str, int]) -> None:
    signature, _ = sent
    fetched = client.call(
        "getTransaction",
        [
            signature,
            {"commitment": "confirmed", "encoding": "json", "maxSupportedTransactionVersion": 1},
        ],
    )
    assert fetched["version"] == 1
    config = fetched["transaction"]["message"]["transactionConfig"]
    assert config["priorityFee"] == EXAMPLE_CONFIG.priority_fee
    assert config["computeUnitLimit"] == EXAMPLE_CONFIG.compute_unit_limit
    assert config["loadedAccountsDataSizeLimit"] == EXAMPLE_CONFIG.loaded_accounts_data_size_limit
    assert config["heapSize"] == EXAMPLE_CONFIG.heap_size
