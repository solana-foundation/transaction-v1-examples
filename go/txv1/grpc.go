// Reading transaction versions and v1 configs off the Yellowstone gRPC wire.
//
// gRPC has no equivalent of maxSupportedTransactionVersion: no opt-in, no
// version field, no server-side filter. Once the gate activates, v1 arrives
// whether the consumer understands it or not.
//
// The generated client in go/pb has to come from a .proto carrying
// Message.config (field 7). Protobuf drops unknown fields, so a client built
// without it decodes every v1 message as v0 with no compute budget and no
// error. See scripts/gen-go-proto.sh.

package txv1

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/solana-foundation/transaction-v1-examples/go/pb"
)

// MessageVersionOf identifies the version of a transaction message received
// over gRPC.
//
// The wire's `versioned` boolean is true for both v0 and v1. The only signal is
// the presence of `config` (field 7), which nothing but v1 sets.
func MessageVersionOf(message *pb.Message) MessageVersion {
	switch {
	case message.Config != nil:
		return VersionV1
	case message.Versioned:
		return VersionV0
	default:
		return VersionLegacy
	}
}

// FormatGRPCConfig renders a protobuf config under the wire's snake_case field
// names. FormatConfig is the JSON-RPC counterpart.
//
// An absent field is not a default: an unset limit resolves to zero, not to the
// generous v0-era defaults.
func FormatGRPCConfig(config *pb.TransactionConfig, indent string) string {
	priorityFee := "unset (0)"
	if config.PriorityFee != nil {
		priorityFee = fmt.Sprintf("%d lamports (total, not micro-lamports/CU)", *config.PriorityFee)
	}
	return strings.Join([]string{
		fmt.Sprintf("%spriority_fee:                    %s", indent, priorityFee),
		fmt.Sprintf("%scompute_unit_limit:              %s", indent, optionalUint32(config.ComputeUnitLimit, "0")),
		fmt.Sprintf("%sloaded_accounts_data_size_limit: %s", indent, optionalUint32(config.LoadedAccountsDataSizeLimit, "0")),
		fmt.Sprintf("%sheap_size:                       %s", indent, optionalUint32(config.HeapSize, "32KB default")),
	}, "\n")
}

func optionalUint32(value *uint32, unsetMeaning string) string {
	if value == nil {
		return fmt.Sprintf("unset (%s)", unsetMeaning)
	}
	return strconv.FormatUint(uint64(*value), 10)
}

// AllTransactionsRequest subscribes to every non-vote, non-failed transaction.
func AllTransactionsRequest() *pb.SubscribeRequest {
	commitment := pb.CommitmentLevel_CONFIRMED
	failed, vote := false, false
	return &pb.SubscribeRequest{
		Commitment: &commitment,
		Transactions: map[string]*pb.SubscribeRequestFilterTransactions{
			"all": {Failed: &failed, Vote: &vote},
		},
	}
}

// AllBlocksRequest subscribes to every block, with its transactions included.
func AllBlocksRequest() *pb.SubscribeRequest {
	commitment := pb.CommitmentLevel_CONFIRMED
	includeTransactions := true
	return &pb.SubscribeRequest{
		Blocks: map[string]*pb.SubscribeRequestFilterBlocks{
			"all": {IncludeTransactions: &includeTransactions},
		},
		Commitment: &commitment,
	}
}

// Subscription is an open Yellowstone gRPC subscription and the connection
// underneath it.
type Subscription struct {
	Stream grpc.BidiStreamingClient[pb.SubscribeRequest, pb.SubscribeUpdate]
	conn   *grpc.ClientConn
}

// Close releases the connection, without which the process would not exit on
// its own.
func (s *Subscription) Close() error {
	return s.conn.Close()
}

// Subscribe opens a subscription to a Yellowstone gRPC endpoint.
//
// It sends the request itself, so a read-only consumer just calls Stream.Recv
// in a loop.
func Subscribe(ctx context.Context, endpoint string, request *pb.SubscribeRequest) (*Subscription, error) {
	target, transport, err := dialTarget(endpoint)
	if err != nil {
		return nil, err
	}

	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(transport))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s: %w", endpoint, err)
	}

	stream, err := pb.NewGeyserClient(conn).Subscribe(ctx)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to open the subscription: %w", err)
	}
	if err := stream.Send(request); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to send the subscription request: %w", err)
	}
	return &Subscription{Stream: stream, conn: conn}, nil
}

// dialTarget splits a URL into the host:port gRPC dials and the transport
// credentials its scheme implies. A plain host:port is treated as insecure.
func dialTarget(endpoint string) (string, credentials.TransportCredentials, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return endpoint, insecure.NewCredentials(), nil
	}
	switch parsed.Scheme {
	case "https":
		return parsed.Host, credentials.NewClientTLSFromCert(nil, ""), nil
	case "http":
		return parsed.Host, insecure.NewCredentials(), nil
	default:
		return "", nil, fmt.Errorf("unsupported gRPC endpoint scheme %q in %s", parsed.Scheme, endpoint)
	}
}

// ReadEnvLimit reads a non-negative integer limit from the environment,
// rejecting a typo instead of ignoring it. Unset or empty means no limit.
func ReadEnvLimit(name string) (uint64, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a non-negative integer, got %q", name, raw)
	}
	return value, nil
}
