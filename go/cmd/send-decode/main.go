// Sends a transaction v1 transfer to a validator and decodes it back.
//
// Recovers the config from both the raw wire bytes and the RPC's JSON
// projection.
//
// Run with `just go-send-decode`.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"

	"github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func main() {
	rpcURL := flag.String("rpc-url", txv1.RPCURL(), "JSON-RPC endpoint")
	flag.Parse()

	if err := run(context.Background(), *rpcURL); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, rpcURL string) error {
	client := rpc.New(rpcURL)

	if err := txv1.AssertV1Active(ctx, client); err != nil {
		return err
	}

	payer, err := txv1.FundedWallet(ctx, client, solana.LAMPORTS_PER_SOL)
	if err != nil {
		return err
	}

	// The compute budget is a property of the message, so the instruction list
	// holds only the transfer. Every field is optional, but an unset limit
	// resolves to zero, so a real transaction sets them explicitly.
	config := solana.TransactionConfig{}.
		WithComputeUnitLimit(20_000).
		WithLoadedAccountsDataSizeLimit(64 * 1024).
		WithHeapSize(64 * 1024).
		// A total in lamports, not micro-lamports per compute unit.
		WithPriorityFee(5_000)

	blockhash, err := client.GetLatestBlockhash(ctx, rpc.CommitmentConfirmed)
	if err != nil {
		return fmt.Errorf("failed to read a blockhash: %w", err)
	}

	transaction, err := txv1.BuildV1Transfer(
		payer,
		solana.NewWallet().PublicKey(),
		10_000_000,
		blockhash.Value.Blockhash,
		config,
	)
	if err != nil {
		return err
	}

	wire, err := transaction.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to serialize the message: %w", err)
	}
	fmt.Println("== compiled locally ==")
	fmt.Printf("  message bytes:      %d\n", len(wire))
	fmt.Printf("  version prefix:     0x%02x\n", wire[0])
	fmt.Printf("  instructions:       %d\n", len(transaction.Message.Instructions))
	fmt.Printf("  lifetime_specifier: %s\n", transaction.Message.RecentBlockhash)
	fmt.Println(txv1.FormatConfig(transaction.Message.TransactionConfig, "  "))

	signature, _, err := txv1.SendAndConfirm(ctx, client, transaction)
	if err != nil {
		return err
	}
	fmt.Printf("\n== sent ==\n  signature: %s\n", signature)

	// Without maxSupportedTransactionVersion the caller is capped at legacy, and
	// the server refuses outright rather than degrading.
	fmt.Println("\n== getTransaction without maxSupportedTransactionVersion ==")
	if _, err := client.GetTransaction(ctx, signature, txv1.TransactionOpts(solana.EncodingBase64, nil)); err != nil {
		fmt.Printf("  rejected: %s\n", txv1.DescribeRejection(err))
	} else {
		fmt.Println("  unexpectedly succeeded")
	}

	encoded, err := client.GetTransaction(
		ctx,
		signature,
		txv1.TransactionOpts(solana.EncodingBase64, &rpc.MaxSupportedTransactionVersion1),
	)
	if err != nil {
		return fmt.Errorf("getTransaction with maxSupportedTransactionVersion 1 failed: %w", err)
	}

	decoded, err := solana.TransactionFromBytes(encoded.Transaction.GetBinary())
	if err != nil {
		return fmt.Errorf("failed to decode the base64 transaction: %w", err)
	}
	if decoded.Message.GetVersion() != solana.MessageVersionV1 {
		return fmt.Errorf("round trip did not produce a v1 message")
	}

	fmt.Println("\n== decoded from base64 wire bytes ==")
	fmt.Printf("  version:            %s\n", txv1.FormatVersion(encoded.Version))
	fmt.Printf("  lifetime_specifier: %s\n", decoded.Message.RecentBlockhash)
	fmt.Println(txv1.FormatConfig(decoded.Message.TransactionConfig, "  "))

	if !txv1.ConfigsEqual(decoded.Message.TransactionConfig, config) {
		return fmt.Errorf("config did not survive the round trip")
	}
	fmt.Println("  config round-tripped exactly")

	asJSON, err := client.GetTransaction(
		ctx,
		signature,
		txv1.TransactionOpts(solana.EncodingJSON, &rpc.MaxSupportedTransactionVersion1),
	)
	if err != nil {
		return fmt.Errorf("getTransaction with json encoding failed: %w", err)
	}
	parsed, err := asJSON.Transaction.GetTransaction()
	if err != nil {
		return fmt.Errorf("failed to read the JSON transaction: %w", err)
	}
	projection, err := json.Marshal(parsed.Message.TransactionConfig)
	if err != nil {
		return fmt.Errorf("failed to render the config: %w", err)
	}
	fmt.Println("\n== the same config as the RPC's JSON projection ==")
	fmt.Printf("  message.transactionConfig: %s\n", projection)

	return nil
}
