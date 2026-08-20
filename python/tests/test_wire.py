"""Offline tests for the v1 wire format and version discrimination.

Nothing here needs a validator.
"""

from __future__ import annotations

from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.message import Message, MessageV0, MessageV1, TransactionConfig, to_bytes_versioned
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from txv1.send import build_v1_transfer
from txv1.v1 import (
    EXAMPLE_CONFIG,
    MessageVersion,
    decode_transaction_version,
    format_config,
    message_version,
)

PAYER = Keypair.from_seed(bytes([1] * 32))
RECIPIENT = Keypair.from_seed(bytes([2] * 32)).pubkey()
BLOCKHASH = Hash.default()


def transfer_instruction() -> Instruction:
    return transfer(TransferParams(from_pubkey=PAYER.pubkey(), to_pubkey=RECIPIENT, lamports=1))


def test_config_lands_on_the_message_not_in_instructions() -> None:
    transaction = build_v1_transfer(PAYER, RECIPIENT, 1, BLOCKHASH, EXAMPLE_CONFIG)
    message = transaction.message
    assert isinstance(message, MessageV1)
    assert message.config == EXAMPLE_CONFIG
    assert len(message.instructions) == 1


def test_v1_announces_itself_with_the_0x81_prefix() -> None:
    message = build_v1_transfer(PAYER, RECIPIENT, 1, BLOCKHASH).message
    assert to_bytes_versioned(message)[0] == 0x81

    v0 = MessageV0.try_compile(PAYER.pubkey(), [transfer_instruction()], [], BLOCKHASH)
    assert to_bytes_versioned(v0)[0] == 0x80


def test_the_config_survives_a_wire_round_trip() -> None:
    transaction = build_v1_transfer(PAYER, RECIPIENT, 1, BLOCKHASH, EXAMPLE_CONFIG)
    version, config = decode_transaction_version(bytes(transaction))
    assert version is MessageVersion.V1
    assert config == EXAMPLE_CONFIG


def test_an_unset_field_is_distinct_from_an_explicit_zero() -> None:
    partial = TransactionConfig(compute_unit_limit=20_000)
    _, config = decode_transaction_version(
        bytes(build_v1_transfer(PAYER, RECIPIENT, 1, BLOCKHASH, partial))
    )
    assert config is not None
    assert config.compute_unit_limit == 20_000
    assert config.priority_fee is None

    zeroed = TransactionConfig(compute_unit_limit=20_000, priority_fee=0)
    _, config = decode_transaction_version(
        bytes(build_v1_transfer(PAYER, RECIPIENT, 1, BLOCKHASH, zeroed))
    )
    assert config is not None
    assert config.priority_fee == 0


def test_message_version_discriminates_all_three_versions() -> None:
    legacy = Message.new_with_blockhash([transfer_instruction()], PAYER.pubkey(), BLOCKHASH)
    v0 = MessageV0.try_compile(PAYER.pubkey(), [transfer_instruction()], [], BLOCKHASH)
    v1 = MessageV1.try_compile(PAYER.pubkey(), [transfer_instruction()], BLOCKHASH, EXAMPLE_CONFIG)

    assert message_version(legacy) is MessageVersion.LEGACY
    assert message_version(v0) is MessageVersion.V0
    assert message_version(v1) is MessageVersion.V1


def test_a_legacy_transaction_decodes_with_no_config() -> None:
    legacy = Message.new_with_blockhash([transfer_instruction()], PAYER.pubkey(), BLOCKHASH)
    transaction = VersionedTransaction(legacy, [PAYER])
    version, config = decode_transaction_version(bytes(transaction))
    assert version is MessageVersion.LEGACY
    assert config is None


def test_format_config_distinguishes_absent_from_zero() -> None:
    assert "unset (0)" in format_config(TransactionConfig())
    assert "unset (32KB default)" in format_config(TransactionConfig())
    rendered = format_config(
        TransactionConfig(
            priority_fee=0,
            compute_unit_limit=0,
            loaded_accounts_data_size_limit=0,
            heap_size=0,
        )
    )
    assert "unset" not in rendered
