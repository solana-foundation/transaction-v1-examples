"""A minimal JSON-RPC client for the transaction v1 examples.

The version-sensitive requests are made through :meth:`RpcClient.call` directly
rather than given a method here, because ``maxSupportedTransactionVersion`` is
the thing the examples vary and a helper would bury it.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
from solders.message import TransactionConfig

from txv1.v1 import format_config

DEFAULT_RPC_URL = "http://127.0.0.1:8899"

# The `getBlock` request options the examples hold constant.
#
# `maxSupportedTransactionVersion` is deliberately absent — it is the field the
# examples vary, and omitting it caps the request at legacy.
BLOCK_CONFIG: dict[str, Any] = {
    "commitment": "confirmed",
    "encoding": "json",
    "rewards": False,
    "transactionDetails": "full",
}

CONFIRMED_STATUSES = frozenset({"confirmed", "finalized"})


class RpcError(Exception):
    """An error the JSON-RPC server returned in the ``error`` member."""

    def __init__(self, method: str, error: dict[str, Any]) -> None:
        super().__init__(f"{method} failed: {error.get('message', error)}")
        self.error = error


class RpcClient:
    """A JSON-RPC client over a single HTTP connection.

    Args:
        url: The endpoint to call. Defaults to ``TXV1_RPC_URL``, then to
            :data:`DEFAULT_RPC_URL`.
    """

    def __init__(self, url: str | None = None, timeout: float = 30.0) -> None:
        self.url = url or os.environ.get("TXV1_RPC_URL") or DEFAULT_RPC_URL
        self._http = httpx.Client(timeout=timeout)
        self._next_id = 0

    def __enter__(self) -> RpcClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        """Sends one request and returns its ``result``.

        Raises:
            RpcError: The server answered with an ``error`` member.
        """
        self._next_id += 1
        response = self._http.post(
            self.url,
            json={
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": method,
                "params": params or [],
            },
        )
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            raise RpcError(method, payload["error"])
        return payload["result"]

    def get_account_info(self, address: str) -> dict[str, Any] | None:
        result = self.call(
            "getAccountInfo", [address, {"commitment": "confirmed", "encoding": "base64"}]
        )
        account: dict[str, Any] | None = result["value"]
        return account

    def get_latest_blockhash(self) -> str:
        result = self.call("getLatestBlockhash", [{"commitment": "confirmed"}])
        blockhash: str = result["value"]["blockhash"]
        return blockhash

    def request_airdrop(self, address: str, lamports: int) -> str:
        signature: str = self.call(
            "requestAirdrop", [address, lamports, {"commitment": "confirmed"}]
        )
        return signature

    def send_transaction(self, wire_transaction_base64: str) -> str:
        signature: str = self.call(
            "sendTransaction",
            [wire_transaction_base64, {"encoding": "base64", "preflightCommitment": "confirmed"}],
        )
        return signature

    def get_signature_status(self, signature: str) -> dict[str, Any] | None:
        result = self.call(
            "getSignatureStatuses", [[signature], {"searchTransactionHistory": False}]
        )
        status: dict[str, Any] | None = result["value"][0]
        return status

    def confirm_transaction(self, signature: str, timeout: float = 60.0) -> dict[str, Any]:
        """Polls until the transaction confirms, and returns its status."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.get_signature_status(signature)
            if status is not None:
                if status["err"] is not None:
                    raise RuntimeError(f"transaction {signature} failed: {status['err']}")
                if status["confirmationStatus"] in CONFIRMED_STATUSES:
                    return status
            time.sleep(0.2)
        raise RuntimeError(f"transaction {signature} did not confirm within {timeout}s")


def format_transaction_config(config: dict[str, Any] | None, indent: str = "  ") -> str:
    """Formats the config a ``getTransaction`` or ``getBlock`` response reports.

    The JSON-RPC projection names the fields in camelCase and spells an absent
    one as ``null``, so it is bridged onto the same rendering the decoded wire
    bytes get.
    """
    if config is None:
        return f"{indent}no transactionConfig"
    return format_config(
        TransactionConfig(
            priority_fee=config.get("priorityFee"),
            compute_unit_limit=config.get("computeUnitLimit"),
            loaded_accounts_data_size_limit=config.get("loadedAccountsDataSizeLimit"),
            heap_size=config.get("heapSize"),
        ),
        indent,
    )
