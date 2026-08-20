// Indexes transactions off a Yellowstone gRPC stream, isolating v1.
//
// SubscribeRequestFilterTransactions has no version field, so a consumer
// subscribes to everything and discriminates on the presence of config.
//
// Run with `just go-grpc-tx-indexer`.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/gagliardetto/solana-go"

	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func main() {
	grpcURL := flag.String("grpc-url", txv1.GRPCURL(), "Yellowstone gRPC endpoint")
	envLimit, err := txv1.ReadEnvLimit("TXV1_EXIT_AFTER_V1")
	if err != nil {
		log.Fatal(err)
	}
	exitAfterV1 := flag.Uint64("exit-after-v1", envLimit, "stop once this many v1 transactions have been seen")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, *grpcURL, *exitAfterV1); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, endpoint string, exitAfterV1 uint64) error {
	subscription, err := txv1.Subscribe(ctx, endpoint, txv1.AllTransactionsRequest())
	if err != nil {
		return err
	}
	defer subscription.Close()

	var tally txv1.VersionTally
	fmt.Printf("subscribed to %s\n", endpoint)

	for {
		update, err := subscription.Stream.Recv()
		if errors.Is(err, io.EOF) || ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return fmt.Errorf("stream failed: %w", err)
		}

		info := update.GetTransaction()
		if info == nil || info.GetTransaction().GetTransaction() == nil {
			continue
		}
		message := info.GetTransaction().GetTransaction().GetMessage()
		if message == nil {
			continue
		}

		version := txv1.MessageVersionOf(message)
		tally.Record(version)

		// This is the line an existing indexer has to change: scanning
		// ComputeBudget instructions alone returns nothing for v1 without
		// erroring.
		budget := txv1.BudgetOfMessage(message)
		fmt.Printf(
			"slot %d %s cu_limit=%s priority_fee=%s lamports sig %s\n",
			info.GetSlot(),
			version,
			formatUint32(budget.ComputeUnitLimit),
			formatUint64(budget.PriorityFee),
			solana.SignatureFromBytes(info.GetTransaction().GetSignature()),
		)

		if version != txv1.VersionV1 {
			continue
		}

		fmt.Println(txv1.FormatGRPCConfig(message.GetConfig(), "  "))
		// On v1 the wire's recent_blockhash slot carries the lifetime specifier.
		fmt.Printf("  lifetime_specifier:              %s\n", solana.HashFromBytes(message.GetRecentBlockhash()))
		fmt.Printf("  address_table_lookups:           %d (v1 never has any)\n", len(message.GetAddressTableLookups()))
		fmt.Printf("  running tally:                   %s\n", tally)

		if exitAfterV1 > 0 && tally.V1 >= exitAfterV1 {
			fmt.Println("\nreached the v1 limit, exiting")
			return nil
		}
	}
}

func formatUint32(value *uint32) string {
	if value == nil {
		return "-"
	}
	return strconv.FormatUint(uint64(*value), 10)
}

func formatUint64(value *uint64) string {
	if value == nil {
		return "-"
	}
	return strconv.FormatUint(*value, 10)
}
