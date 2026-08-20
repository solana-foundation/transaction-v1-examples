"""Reads a block containing v1 transactions over JSON-RPC.

When `maxSupportedTransactionVersion` is below the highest version in the
block, the entire request fails — a caller pinned at 0 loses whole blocks.

Run with `just py-get-block`.
"""

from __future__ import annotations

import sys
from typing import Any

from txv1.feature import assert_v1_active
from txv1.rpc import BLOCK_CONFIG, RpcClient, RpcError, format_transaction_config
from txv1.send import send_v1_transfer


def get_block(client: RpcClient, slot: int, **options: Any) -> Any:
    return client.call("getBlock", [slot, {**BLOCK_CONFIG, **options}])


def main() -> None:
    with RpcClient() as client:
        if len(sys.argv) > 1:
            slot = int(sys.argv[1])
        else:
            assert_v1_active(client)
            _, slot = send_v1_transfer(client)
        print(f"reading slot {slot}\n")

        print("== maxSupportedTransactionVersion omitted ==")
        try:
            get_block(client, slot)
            print("  succeeded: this block holds no versioned transactions")
        except RpcError as error:
            print(f"  rejected: {error}")

        print("\n== maxSupportedTransactionVersion 0 ==")
        try:
            get_block(client, slot, maxSupportedTransactionVersion=0)
            print("  succeeded: this block holds no v1 transactions")
        except RpcError as error:
            print(f"  rejected: {error}")

        print("\n== maxSupportedTransactionVersion 1 ==")
        block = get_block(client, slot, maxSupportedTransactionVersion=1)
        if block is None or "transactions" not in block:
            raise RuntimeError(f"slot {slot} has no transaction details")
        transactions = block["transactions"]

        # JSON-RPC reports the version, but only because the request opted
        # in. A transaction with no `version` member is legacy.
        tally = {"legacy": 0, "v0": 0, "v1": 0}
        for transaction in transactions:
            version = transaction.get("version")
            tally["v1" if version == 1 else "v0" if version == 0 else "legacy"] += 1
        print(
            f"  legacy={tally['legacy']} v0={tally['v0']} v1={tally['v1']} "
            f"of {len(transactions)} transactions"
        )

        for transaction in transactions:
            if transaction.get("version") != 1:
                continue
            print(f"  v1 {transaction['transaction']['signatures'][0]}")
            config = transaction["transaction"]["message"].get("transactionConfig")
            print(format_transaction_config(config, "    "))


if __name__ == "__main__":
    main()
