"""Building and sending transaction v1 messages."""

from __future__ import annotations

import base64

from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV1, TransactionConfig
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from txv1.rpc import RpcClient
from txv1.v1 import EXAMPLE_CONFIG


def funded_keypair(client: RpcClient, lamports: int) -> Keypair:
    """Creates a keypair funded by airdrop, waiting for the airdrop to confirm."""
    payer = Keypair()
    signature = client.request_airdrop(str(payer.pubkey()), lamports)
    client.confirm_transaction(signature)
    return payer


def build_v1_transfer(
    payer: Keypair,
    recipient: Pubkey,
    lamports: int,
    blockhash: Hash,
    config: TransactionConfig = EXAMPLE_CONFIG,
) -> VersionedTransaction:
    """Builds a signed v1 SOL transfer.

    The compute budget travels in the message's ``TransactionConfig``, so the
    instruction list holds only the transfer itself.
    """
    instruction = transfer(
        TransferParams(from_pubkey=payer.pubkey(), to_pubkey=recipient, lamports=lamports)
    )
    message = MessageV1.try_compile(payer.pubkey(), [instruction], blockhash, config)
    return VersionedTransaction(message, [payer])


def send_and_confirm(client: RpcClient, transaction: VersionedTransaction) -> str:
    """Sends a signed transaction and waits for it to confirm.

    ``bytes()`` on a versioned transaction produces the wincode encoding, which
    is byte-identical to bincode for legacy and v0 and is the only encoding that
    can carry a v1 message.
    """
    signature = client.send_transaction(base64.b64encode(bytes(transaction)).decode())
    client.confirm_transaction(signature)
    return signature


def send_v1_transfer(client: RpcClient) -> tuple[str, int]:
    """Sends a v1 transfer from a freshly airdropped payer.

    Returns:
        The transaction's signature and the slot it landed in.
    """
    payer = funded_keypair(client, 1_000_000_000)
    recipient = Keypair().pubkey()
    transaction = build_v1_transfer(
        payer, recipient, 10_000_000, Hash.from_string(client.get_latest_blockhash())
    )
    signature = send_and_confirm(client, transaction)
    status = client.get_signature_status(signature)
    if status is None:
        raise RuntimeError(f"no status for transaction {signature}")
    slot: int = status["slot"]
    return signature, slot
