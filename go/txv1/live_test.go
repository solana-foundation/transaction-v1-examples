// Tests that run against a live validator.
//
// They skip unless TXV1_LIVE is set, so `go test ./...` stays offline by
// default. Run them with `just test-live`, which starts a 4.2.1 validator with
// the Yellowstone geyser plugin first.
//
// Endpoints come from TXV1_RPC_URL and TXV1_GRPC_URL.

package txv1_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/solana-foundation/solana-go/v2"
	"github.com/solana-foundation/solana-go/v2/rpc"

	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func requireLive(t *testing.T) {
	t.Helper()
	if os.Getenv("TXV1_LIVE") == "" {
		t.Skip("set TXV1_LIVE=1 to run against a validator")
	}
}

func liveContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func sendV1(t *testing.T, ctx context.Context, client *rpc.Client) (solana.Signature, uint64) {
	t.Helper()
	signature, slot, err := txv1.SendV1Transfer(ctx, client)
	if err != nil {
		t.Fatalf("sending a v1 transfer: %v", err)
	}
	return signature, slot
}

func TestLiveAV1TransactionLandsAndReportsVersion1(t *testing.T) {
	requireLive(t)
	ctx := liveContext(t)
	client := txv1.NewClient()
	signature, _ := sendV1(t, ctx, client)

	fetched, err := client.GetTransaction(
		ctx,
		signature,
		txv1.TransactionOpts(solana.EncodingJSON, &rpc.MaxSupportedTransactionVersion1),
	)
	if err != nil {
		t.Fatalf("getTransaction: %v", err)
	}
	if fetched.Version != 1 {
		t.Errorf("version: got %v, want 1", fetched.Version)
	}
}

func TestLiveGetTransactionRejectsV1WhenTheVersionCeilingIsTooLow(t *testing.T) {
	requireLive(t)
	ctx := liveContext(t)
	client := txv1.NewClient()
	signature, _ := sendV1(t, ctx, client)

	for _, ceiling := range []*uint64{nil, &rpc.MaxSupportedTransactionVersion0} {
		_, err := client.GetTransaction(ctx, signature, txv1.TransactionOpts(solana.EncodingJSON, ceiling))
		if err == nil {
			t.Fatal("a v1 transaction must not be served below a v1 ceiling")
		}
		if !strings.Contains(err.Error(), "maxSupportedTransactionVersion") {
			t.Errorf("unexpected error for ceiling %v: %v", ceiling, err)
		}
	}
}

func TestLiveTheRPCJSONProjectionCarriesTheTransactionConfig(t *testing.T) {
	requireLive(t)
	ctx := liveContext(t)
	client := txv1.NewClient()
	signature, _ := sendV1(t, ctx, client)

	fetched, err := client.GetTransaction(
		ctx,
		signature,
		txv1.TransactionOpts(solana.EncodingJSON, &rpc.MaxSupportedTransactionVersion1),
	)
	if err != nil {
		t.Fatalf("getTransaction: %v", err)
	}
	transaction, err := fetched.Transaction.GetTransaction()
	if err != nil {
		t.Fatalf("reading the JSON transaction: %v", err)
	}
	if !txv1.ConfigsEqual(transaction.Message.TransactionConfig, txv1.ExampleConfig()) {
		t.Errorf("transactionConfig: got %+v, want %+v",
			transaction.Message.TransactionConfig, txv1.ExampleConfig())
	}
}

func TestLiveGetBlockFailsEntirelyWhenAV1TransactionIsPresent(t *testing.T) {
	requireLive(t)
	ctx := liveContext(t)
	client := txv1.NewClient()
	_, slot := sendV1(t, ctx, client)

	// The whole block is refused, not just the v1 transaction inside it.
	_, err := client.GetBlockWithOpts(ctx, slot, txv1.BlockOpts(&rpc.MaxSupportedTransactionVersion0))
	if err == nil {
		t.Fatal("a block holding a v1 transaction must not be served at a v0 ceiling")
	}
	if !strings.Contains(err.Error(), "maxSupportedTransactionVersion") {
		t.Errorf("expected a version-ceiling rejection, got: %v", err)
	}

	block, err := client.GetBlockWithOpts(ctx, slot, txv1.BlockOpts(&rpc.MaxSupportedTransactionVersion1))
	if err != nil {
		t.Fatalf("getBlock at a v1 ceiling: %v", err)
	}
	found := false
	for _, entry := range block.Transactions {
		if entry.Version == 1 {
			found = true
			break
		}
	}
	if !found {
		t.Error("the block must contain the v1 transaction just sent")
	}
}

func TestLiveTheGRPCStreamDeliversTheV1ConfigIntact(t *testing.T) {
	requireLive(t)
	ctx := liveContext(t)

	subscription, err := txv1.Subscribe(ctx, txv1.GRPCURL(), txv1.AllTransactionsRequest())
	if err != nil {
		t.Fatalf("subscribing: %v", err)
	}
	defer subscription.Close()

	sent := make(chan error, 1)
	go func() {
		_, _, err := txv1.SendV1Transfer(ctx, txv1.NewClient())
		sent <- err
	}()

	for {
		update, err := subscription.Stream.Recv()
		if err != nil {
			t.Fatalf("stream ended before a v1 transaction arrived: %v", err)
		}
		message := update.GetTransaction().GetTransaction().GetTransaction().GetMessage()
		if message == nil || txv1.MessageVersionOf(message) != txv1.VersionV1 {
			continue
		}

		if !message.GetVersioned() {
			t.Error("`versioned` is true for v1 as well as v0, which is why it cannot pick a version")
		}
		if !txv1.ConfigsEqual(txv1.BudgetOfMessage(message), txv1.ExampleConfig()) {
			t.Errorf("config: got %+v, want %+v", message.GetConfig(), txv1.ExampleConfig())
		}
		if len(message.GetAddressTableLookups()) != 0 {
			t.Error("v1 has no address lookup tables")
		}
		break
	}

	if err := <-sent; err != nil {
		t.Fatalf("sending a v1 transfer: %v", err)
	}
}
