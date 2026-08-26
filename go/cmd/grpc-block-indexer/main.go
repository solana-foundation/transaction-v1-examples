// Indexes whole blocks off a Yellowstone gRPC stream, tallying versions.
//
// Unlike getBlock there is no ceiling to opt into and no error when v1 appears:
// the block arrives, and an unprepared consumer counts v1 as v0.
//
// Run with `just go-grpc-block-indexer`.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os/signal"
	"syscall"

	"github.com/solana-foundation/solana-go/v2"

	"github.com/solana-foundation/transaction-v1-examples/go/pb"
	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func main() {
	grpcURL := flag.String("grpc-url", txv1.GRPCURL(), "Yellowstone gRPC endpoint")
	envLimit, err := txv1.ReadEnvLimit("TXV1_EXIT_AFTER_V1_BLOCKS")
	if err != nil {
		log.Fatal(err)
	}
	exitAfterV1Blocks := flag.Uint64(
		"exit-after-v1-blocks",
		envLimit,
		"stop once this many blocks containing a v1 transaction have been seen",
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, *grpcURL, *exitAfterV1Blocks); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, endpoint string, exitAfterV1Blocks uint64) error {
	subscription, err := txv1.Subscribe(ctx, endpoint, txv1.AllBlocksRequest())
	if err != nil {
		return err
	}
	defer subscription.Close()

	var blocksWithV1 uint64
	fmt.Printf("subscribed to %s\n", endpoint)

	for {
		update, err := subscription.Stream.Recv()
		if errors.Is(err, io.EOF) || ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return fmt.Errorf("stream failed: %w", err)
		}

		block := update.GetBlock()
		if block == nil {
			continue
		}

		var tally txv1.VersionTally
		var v1Transactions []v1Transaction
		var priorityFeeLamports uint64

		for _, transaction := range block.GetTransactions() {
			message := transaction.GetTransaction().GetMessage()
			if message == nil {
				continue
			}
			version := txv1.MessageVersionOf(message)
			tally.Record(version)
			// Summing across versions only works because the budget accessor
			// normalises v0's micro-lamports-per-CU price into a total.
			if fee := txv1.BudgetOfMessage(message).PriorityFee; fee != nil {
				priorityFeeLamports += *fee
			}
			if version == txv1.VersionV1 {
				v1Transactions = append(v1Transactions, v1Transaction{
					config:    message.GetConfig(),
					signature: solana.SignatureFromBytes(transaction.GetSignature()),
				})
			}
		}

		fmt.Printf(
			"slot %d (%d txs): %s priority_fees=%d lamports\n",
			block.GetSlot(),
			block.GetExecutedTransactionCount(),
			tally,
			priorityFeeLamports,
		)
		for _, transaction := range v1Transactions {
			fmt.Printf("  v1 %s\n", transaction.signature)
			if transaction.config != nil {
				fmt.Println(txv1.FormatGRPCConfig(transaction.config, "    "))
			}
		}

		if len(v1Transactions) > 0 {
			blocksWithV1++
			if exitAfterV1Blocks > 0 && blocksWithV1 >= exitAfterV1Blocks {
				fmt.Println("\nreached the v1 block limit, exiting")
				return nil
			}
		}
	}
}

type v1Transaction struct {
	config    *pb.TransactionConfig
	signature solana.Signature
}
