// Request options and display helpers for the JSON-RPC examples.

package txv1

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/solana-foundation/solana-go/v2"
	"github.com/solana-foundation/solana-go/v2/rpc"
	"github.com/solana-foundation/solana-go/v2/rpc/jsonrpc"
)

// BlockOpts returns the getBlock options the examples hold constant, with the
// version ceiling the caller wants.
//
// maxSupportedTransactionVersion is the one field the examples vary; a nil
// ceiling omits it, which caps the request at legacy.
func BlockOpts(maxSupportedTransactionVersion *uint64) *rpc.GetBlockOpts {
	rewards := false
	return &rpc.GetBlockOpts{
		Commitment:                     rpc.CommitmentConfirmed,
		Encoding:                       solana.EncodingJSON,
		MaxSupportedTransactionVersion: maxSupportedTransactionVersion,
		Rewards:                        &rewards,
		TransactionDetails:             rpc.TransactionDetailsFull,
	}
}

// TransactionOpts returns the getTransaction options the examples hold
// constant, with the version ceiling the caller wants.
func TransactionOpts(encoding solana.EncodingType, maxSupportedTransactionVersion *uint64) *rpc.GetTransactionOpts {
	return &rpc.GetTransactionOpts{
		Commitment:                     rpc.CommitmentConfirmed,
		Encoding:                       encoding,
		MaxSupportedTransactionVersion: maxSupportedTransactionVersion,
	}
}

// FormatConfig renders a solana-go config, the shape JSON-RPC decodes into,
// under its camelCase JSON field names. FormatGRPCConfig is the protobuf
// counterpart.
//
// An absent field is not a default: an unset limit resolves to zero, and only
// the heap size falls back to 32 KB. On legacy and v0 an absent compute unit
// limit resolves to DefaultComputeUnitLimit instead.
func FormatConfig(config solana.TransactionConfig, indent string) string {
	priorityFee := "unset (0)"
	if config.PriorityFee != nil {
		priorityFee = fmt.Sprintf("%d lamports (total, not micro-lamports/CU)", *config.PriorityFee)
	}
	return strings.Join([]string{
		fmt.Sprintf("%spriorityFee:                  %s", indent, priorityFee),
		fmt.Sprintf("%scomputeUnitLimit:             %s", indent, optionalUint32(config.ComputeUnitLimit, "0")),
		fmt.Sprintf("%sloadedAccountsDataSizeLimit:  %s", indent, optionalUint32(config.LoadedAccountsDataSizeLimit, "0")),
		fmt.Sprintf("%sheapSize:                     %s", indent, optionalUint32(config.HeapSize, "32KB default")),
	}, "\n")
}

// FormatVersion renders the version a JSON-RPC response reports.
func FormatVersion(version rpc.TransactionVersion) string {
	if version == rpc.LegacyTransactionVersion {
		return "legacy"
	}
	return "v" + strconv.Itoa(int(version))
}

// VersionOfResponse maps the version a JSON-RPC response reports onto a
// MessageVersion.
//
// rpc.TransactionVersion is an int whose zero value is 0 — v0, not "unknown" —
// so an unrecognised version has to be rejected explicitly.
func VersionOfResponse(version rpc.TransactionVersion) (MessageVersion, error) {
	switch version {
	case rpc.LegacyTransactionVersion:
		return VersionLegacy, nil
	case 0:
		return VersionV0, nil
	case 1:
		return VersionV1, nil
	default:
		return VersionLegacy, fmt.Errorf("unrecognised transaction version %d", int(version))
	}
}

// DescribeRejection renders an RPC error as a single line.
//
// jsonrpc.RPCError's own Error() dumps the struct across several lines, which
// buries the message that names the parameter the caller has to raise.
func DescribeRejection(err error) string {
	var rpcError *jsonrpc.RPCError
	if errors.As(err, &rpcError) {
		return fmt.Sprintf("%s (code %d)", rpcError.Message, rpcError.Code)
	}
	return err.Error()
}
