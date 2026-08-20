"""Sends a transaction v1 transfer to a validator and decodes it back.

Recovers the config from both the raw wire bytes and the RPC's JSON projection.

Run with `just py-send-decode`.
"""

from __future__ import annotations

import base64

from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV1, to_bytes_versioned

from txv1.feature import assert_v1_active
from txv1.rpc import RpcClient, RpcError, format_transaction_config
from txv1.send import build_v1_transfer, funded_keypair, send_and_confirm
from txv1.v1 import EXAMPLE_CONFIG, decode_transaction_version, format_config


def main() -> None:
    with RpcClient() as client:
        assert_v1_active(client)

        payer = funded_keypair(client, 1_000_000_000)
        recipient = Keypair().pubkey()
        blockhash = Hash.from_string(client.get_latest_blockhash())

        # The compute budget is a property of the message, so the instruction
        # list holds only the transfer.
        transaction = build_v1_transfer(payer, recipient, 10_000_000, blockhash, EXAMPLE_CONFIG)
        message = transaction.message
        assert isinstance(message, MessageV1)

        # `bytes()` on the message omits the version prefix; `to_bytes_versioned`
        # is what goes on the wire, and v1 announces itself with 0x81.
        wire_message = to_bytes_versioned(message)
        print("== compiled locally ==")
        print(f"  message bytes:      {len(wire_message)}")
        print(f"  version prefix:     0x{wire_message[0]:02x}")
        print(f"  instructions:       {len(message.instructions)}")
        print(f"  lifetime_specifier: {message.lifetime_specifier}")
        print(format_config(message.config))

        signature = send_and_confirm(client, transaction)
        print(f"\n== sent ==\n  signature: {signature}")

        # Without `maxSupportedTransactionVersion` the caller is capped at
        # legacy, and the server refuses outright rather than degrading.
        print("\n== getTransaction without maxSupportedTransactionVersion ==")
        try:
            client.call(
                "getTransaction", [signature, {"commitment": "confirmed", "encoding": "base64"}]
            )
            print("  unexpectedly succeeded")
        except RpcError as error:
            print(f"  rejected: {error}")

        encoded = client.call(
            "getTransaction",
            [
                signature,
                {
                    "commitment": "confirmed",
                    "encoding": "base64",
                    "maxSupportedTransactionVersion": 1,
                },
            ],
        )
        version, config = decode_transaction_version(base64.b64decode(encoded["transaction"][0]))
        print("\n== decoded from base64 wire bytes ==")
        print(f"  version:            {version.value}")
        print(format_config(config))

        if config != message.config:
            raise RuntimeError("config did not survive the round trip")
        print("  config round-tripped exactly")

        fetched = client.call(
            "getTransaction",
            [
                signature,
                {
                    "commitment": "confirmed",
                    "encoding": "json",
                    "maxSupportedTransactionVersion": 1,
                },
            ],
        )
        print("\n== the same config as the RPC's JSON projection ==")
        print(f"  version:            {fetched['version']}")
        print(format_transaction_config(fetched["transaction"]["message"].get("transactionConfig")))


if __name__ == "__main__":
    main()
