// Reads a block containing v1 transactions over JSON-RPC.
//
// When maxSupportedTransactionVersion is below the highest version present, the
// whole request fails rather than degrading, so a caller pinned at 0 loses
// entire blocks as soon as v1 traffic appears.
//
// Run with `just go-get-block`.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"strconv"

	"github.com/solana-foundation/solana-go/v2"
	"github.com/solana-foundation/solana-go/v2/rpc"

	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func main() {
	rpcURL := flag.String("rpc-url", txv1.RPCURL(), "JSON-RPC endpoint")
	// Empty rather than 0 for "not given", because 0 is a real slot.
	slot := flag.String("slot", "", "slot to read; defaults to the slot of a freshly sent v1 transaction")
	flag.Parse()

	if err := run(context.Background(), *rpcURL, *slot); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context, rpcURL string, requestedSlot string) error {
	client := rpc.New(rpcURL)

	var slot uint64
	if requestedSlot == "" {
		_, sent, err := txv1.SendV1Transfer(ctx, client)
		if err != nil {
			return err
		}
		slot = sent
	} else {
		parsed, err := strconv.ParseUint(requestedSlot, 10, 64)
		if err != nil {
			return fmt.Errorf("-slot must be a slot number, got %q", requestedSlot)
		}
		slot = parsed
	}
	fmt.Printf("reading slot %d\n\n", slot)

	fmt.Println("== maxSupportedTransactionVersion omitted ==")
	if _, err := client.GetBlockWithOpts(ctx, slot, txv1.BlockOpts(nil)); err != nil {
		fmt.Printf("  rejected: %s\n", txv1.DescribeRejection(err))
	} else {
		fmt.Println("  succeeded: this block holds no versioned transactions")
	}

	fmt.Println("\n== maxSupportedTransactionVersion: 0 ==")
	if _, err := client.GetBlockWithOpts(ctx, slot, txv1.BlockOpts(&rpc.MaxSupportedTransactionVersion0)); err != nil {
		fmt.Printf("  rejected: %s\n", txv1.DescribeRejection(err))
	} else {
		fmt.Println("  succeeded: this block holds no v1 transactions")
	}

	fmt.Println("\n== maxSupportedTransactionVersion: 1 ==")
	block, err := client.GetBlockWithOpts(ctx, slot, txv1.BlockOpts(&rpc.MaxSupportedTransactionVersion1))
	if err != nil {
		return fmt.Errorf("getBlock with maxSupportedTransactionVersion 1 failed: %w", err)
	}
	report(block)

	return nil
}

func report(block *rpc.GetBlockResult) {
	if len(block.Transactions) == 0 {
		fmt.Println("  block carried no transaction details")
		return
	}

	var tally txv1.VersionTally
	var v1Lines []string

	for _, entry := range block.Transactions {
		// Unlike gRPC, JSON-RPC reports the version — but only because the
		// request opted in.
		version, err := txv1.VersionOfResponse(entry.Version)
		if err != nil {
			// Folding an unrecognised version into an existing bucket is how v1
			// first shows up as v0 in an unprepared pipeline.
			fmt.Printf("  warning: %s, not tallied\n", err)
			continue
		}
		tally.Record(version)

		if version != txv1.VersionV1 {
			continue
		}
		transaction, err := entry.GetTransaction()
		if err != nil {
			continue
		}
		signature := "?"
		if len(transaction.Signatures) > 0 {
			signature = transaction.Signatures[0].String()
		}
		v1Lines = append(v1Lines, fmt.Sprintf(
			"  %s\n%s",
			signature,
			describe(transaction.Message.TransactionConfig),
		))
	}

	fmt.Printf("  %s of %d transactions\n", tally, tally.Total())
	for _, line := range v1Lines {
		fmt.Println(line)
	}
}

// describe renders a v1 transaction's config.
//
// solana-go models the config as a value, not a pointer, so a v1 transaction
// whose transactionConfig the response omitted is indistinguishable from one
// that set no fields.
func describe(config solana.TransactionConfig) string {
	if config.IsEmpty() {
		return "    no transactionConfig on a v1 transaction"
	}
	return txv1.FormatConfig(config, "    ")
}
