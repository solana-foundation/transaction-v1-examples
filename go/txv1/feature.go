// Checking whether transaction v1 is live on a cluster.

package txv1

import (
	"context"
	"errors"
	"fmt"

	"github.com/solana-foundation/solana-go/v2"
	"github.com/solana-foundation/solana-go/v2/rpc"
)

// EnableTxV1Feature is the feature gate that activates transaction v1.
var EnableTxV1Feature = solana.MustPublicKeyFromBase58("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL")

// IsV1Active reports whether enable_tx_v1 is activated on the cluster behind
// client.
//
// A feature account holds a bincode Option<u64>: a one-byte tag, then the slot
// the gate activated at when the tag is set. An absent account and a
// staged-but-inactive one both mean a v1 transaction would be rejected, so both
// answer false.
func IsV1Active(ctx context.Context, client *rpc.Client) (bool, error) {
	account, err := client.GetAccountInfoWithOpts(ctx, EnableTxV1Feature, &rpc.GetAccountInfoOpts{
		Commitment: rpc.CommitmentConfirmed,
		Encoding:   solana.EncodingBase64,
	})
	if errors.Is(err, rpc.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to read the enable_tx_v1 feature account: %w", err)
	}

	// An account at this address that the feature program does not own is not a
	// feature account, whatever its first byte happens to be.
	if !account.Value.Owner.Equals(solana.FeatureProgramID) {
		return false, nil
	}

	data := account.Value.Data.GetBinary()
	if len(data) == 0 || data[0] == 0 {
		return false, nil
	}
	if len(data) < 1+8 {
		return false, fmt.Errorf("feature account holds %d bytes, too few for an activation slot", len(data))
	}
	return true, nil
}

// AssertV1Active fails unless enable_tx_v1 is activated on the cluster behind
// client.
//
// Checked up front so an inactive gate names itself, rather than surfacing as a
// rejected transaction whose error says nothing about the version.
func AssertV1Active(ctx context.Context, client *rpc.Client) error {
	active, err := IsV1Active(ctx, client)
	if err != nil {
		return err
	}
	if !active {
		return fmt.Errorf(
			"enable_tx_v1 (%s) is not activated on this cluster; a v1 transaction would be rejected",
			EnableTxV1Feature,
		)
	}
	return nil
}
