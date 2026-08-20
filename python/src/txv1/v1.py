"""Transaction v1 message identification and decoding."""

from __future__ import annotations

from enum import Enum

from solders.message import MessageV0, MessageV1, TransactionConfig, VersionedMessage
from solders.transaction import VersionedTransaction

# The compute budget the examples send, with every field set.
#
# The heap size is deliberately not 32 KB, which is what an *unset* heap
# resolves to and so would be indistinguishable from omitting the field.
EXAMPLE_CONFIG = TransactionConfig(
    # A total in lamports, not micro-lamports per compute unit.
    priority_fee=5_000,
    compute_unit_limit=20_000,
    loaded_accounts_data_size_limit=64 * 1024,
    heap_size=64 * 1024,
)


class MessageVersion(str, Enum):
    """The version of a transaction message."""

    LEGACY = "legacy"
    V0 = "v0"
    V1 = "v1"


def message_version(message: VersionedMessage) -> MessageVersion:
    if isinstance(message, MessageV1):
        return MessageVersion.V1
    if isinstance(message, MessageV0):
        return MessageVersion.V0
    return MessageVersion.LEGACY


def decode_transaction_version(
    wire_transaction: bytes,
) -> tuple[MessageVersion, TransactionConfig | None]:
    """Reads the version and config out of a serialized transaction.

    Args:
        wire_transaction: The signed transaction exactly as it goes on the wire.
    """
    message = VersionedTransaction.from_bytes(wire_transaction).message
    if isinstance(message, MessageV1):
        return MessageVersion.V1, message.config
    return message_version(message), None


def format_config(config: TransactionConfig | None, indent: str = "  ") -> str:
    """Renders a config for display, spelling out what each absent field means.

    An absent limit resolves to zero, and only ``heap_size`` falls back to the
    32 KB default. An explicit zero is a different thing from an absent field,
    so the two are never collapsed.
    """
    if config is None:
        return f"{indent}no transaction config"

    def described(value: int | None, absent: str) -> str:
        return absent if value is None else str(value)

    priority_fee = (
        "unset (0)"
        if config.priority_fee is None
        else f"{config.priority_fee} lamports (total, not micro-lamports/CU)"
    )
    loaded_accounts = described(config.loaded_accounts_data_size_limit, "unset (0)")
    return "\n".join(
        [
            f"{indent}priority_fee:                    {priority_fee}",
            f"{indent}compute_unit_limit:              "
            f"{described(config.compute_unit_limit, 'unset (0)')}",
            f"{indent}loaded_accounts_data_size_limit: {loaded_accounts}",
            f"{indent}heap_size:                       "
            f"{described(config.heap_size, 'unset (32KB default)')}",
        ]
    )
