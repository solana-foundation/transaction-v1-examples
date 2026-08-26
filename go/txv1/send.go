// Building and sending transaction v1 messages.

package txv1

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/solana-foundation/solana-go/v2"
	"github.com/solana-foundation/solana-go/v2/programs/system"
	"github.com/solana-foundation/solana-go/v2/rpc"
)

// ExampleConfig is a compute budget that exercises all four
// TransactionConfig fields.
//
// The heap size is deliberately not 32 KB, which is what an unset heap resolves
// to and so would be indistinguishable from omitting the field.
func ExampleConfig() solana.TransactionConfig {
	return solana.TransactionConfig{}.
		WithComputeUnitLimit(20_000).
		WithLoadedAccountsDataSizeLimit(64 * 1024).
		WithHeapSize(64 * 1024).
		// A total in lamports, not micro-lamports per compute unit.
		WithPriorityFee(5_000)
}

// NewClient connects to the endpoint named by TXV1_RPC_URL.
func NewClient() *rpc.Client {
	return rpc.New(RPCURL())
}

// FundedWallet creates a wallet funded by airdrop, waiting for the airdrop to
// confirm.
func FundedWallet(ctx context.Context, client *rpc.Client, lamports uint64) (*solana.Wallet, error) {
	payer := solana.NewWallet()
	signature, err := client.RequestAirdrop(ctx, payer.PublicKey(), lamports, rpc.CommitmentConfirmed)
	if err != nil {
		return nil, fmt.Errorf("airdrop request failed; is a local validator running?: %w", err)
	}
	if _, err := WaitForConfirmation(ctx, client, signature); err != nil {
		return nil, fmt.Errorf("airdrop did not confirm: %w", err)
	}
	return payer, nil
}

// BuildV1Transfer builds and signs a v1 SOL transfer.
//
// The compute budget travels in the message's TransactionConfig, so the
// instruction list holds only the transfer itself.
func BuildV1Transfer(
	payer *solana.Wallet,
	recipient solana.PublicKey,
	lamports uint64,
	blockhash solana.Hash,
	config solana.TransactionConfig,
) (*solana.Transaction, error) {
	transaction, err := solana.NewTransaction(
		[]solana.Instruction{
			system.NewTransferInstruction(lamports, payer.PublicKey(), recipient).Build(),
		},
		blockhash,
		solana.TransactionPayer(payer.PublicKey()),
		// Selects the v1 message format and embeds the compute budget.
		solana.TransactionV1Config(config),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to build the v1 transfer: %w", err)
	}
	signer := func(key solana.PublicKey) *solana.PrivateKey {
		if payer.PublicKey().Equals(key) {
			return &payer.PrivateKey
		}
		return nil
	}
	if _, err := transaction.Sign(signer); err != nil {
		return nil, fmt.Errorf("failed to sign the v1 transfer: %w", err)
	}
	return transaction, nil
}

// SendAndConfirm submits a signed transaction and waits for it to confirm,
// returning the slot it landed in.
func SendAndConfirm(
	ctx context.Context,
	client *rpc.Client,
	transaction *solana.Transaction,
) (solana.Signature, uint64, error) {
	signature, err := client.SendTransactionWithOpts(ctx, transaction, rpc.TransactionOpts{
		PreflightCommitment: rpc.CommitmentConfirmed,
	})
	if err != nil {
		return solana.Signature{}, 0, fmt.Errorf("failed to send the transaction: %w", err)
	}
	slot, err := WaitForConfirmation(ctx, client, signature)
	if err != nil {
		return signature, 0, err
	}
	return signature, slot, nil
}

// SendV1Transfer airdrops a payer, sends a v1 transfer, and returns the
// signature and the slot it landed in.
func SendV1Transfer(ctx context.Context, client *rpc.Client) (solana.Signature, uint64, error) {
	payer, err := FundedWallet(ctx, client, solana.LAMPORTS_PER_SOL)
	if err != nil {
		return solana.Signature{}, 0, err
	}
	blockhash, err := client.GetLatestBlockhash(ctx, rpc.CommitmentConfirmed)
	if err != nil {
		return solana.Signature{}, 0, fmt.Errorf("failed to read a blockhash: %w", err)
	}
	transaction, err := BuildV1Transfer(
		payer,
		solana.NewWallet().PublicKey(),
		10_000_000,
		blockhash.Value.Blockhash,
		ExampleConfig(),
	)
	if err != nil {
		return solana.Signature{}, 0, err
	}
	return SendAndConfirm(ctx, client, transaction)
}

// WaitForConfirmation waits for a transaction to reach the confirmed commitment
// level and returns the slot it landed in.
//
// solana-go's send helpers confirm over a websocket subscription; polling keeps
// the examples to the one JSON-RPC endpoint the rest of them use.
func WaitForConfirmation(ctx context.Context, client *rpc.Client, signature solana.Signature) (uint64, error) {
	const (
		interval = 500 * time.Millisecond
		timeout  = 60 * time.Second
	)

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		statuses, err := client.GetSignatureStatuses(ctx, true, signature)
		// A transaction the cluster has not seen yet reads as not-found, which is
		// the normal state on the first few polls; anything else is a real failure
		// and reporting it beats timing out with a message about confirmation.
		if err != nil && !errors.Is(err, rpc.ErrNotFound) && ctx.Err() == nil {
			return 0, fmt.Errorf("failed to read the status of %s: %w", signature, err)
		}
		if err == nil && len(statuses.Value) > 0 && statuses.Value[0] != nil {
			status := statuses.Value[0]
			if status.Err != nil {
				return 0, fmt.Errorf("transaction %s failed: %v", signature, status.Err)
			}
			switch status.ConfirmationStatus {
			case rpc.ConfirmationStatusConfirmed, rpc.ConfirmationStatusFinalized:
				return status.Slot, nil
			}
		}

		select {
		case <-ctx.Done():
			return 0, fmt.Errorf("transaction %s did not confirm within %s", signature, timeout)
		case <-ticker.C:
		}
	}
}
