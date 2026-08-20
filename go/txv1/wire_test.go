// Offline tests for the v1 wire format and version discrimination.
//
// Nothing here needs a validator: a v1 message can be compiled, serialized, and
// deserialized entirely in process.

package txv1_test

import (
	"testing"

	bin "github.com/gagliardetto/binary"
	"github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"

	"github.com/solana-foundation/transaction-v1-examples/go/pb"
	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func compile(t *testing.T, config solana.TransactionConfig) *solana.Transaction {
	t.Helper()
	transaction, err := txv1.BuildV1Transfer(
		solana.NewWallet(),
		solana.NewWallet().PublicKey(),
		1,
		solana.Hash(solana.NewWallet().PublicKey()),
		config,
	)
	if err != nil {
		t.Fatalf("v1 transfer builds: %v", err)
	}
	return transaction
}

// deserializeMessage reads a bare v1 message body back.
//
// MarshalBinary emits the 0x81 version prefix, and UnmarshalWithDecoder reads it
// back off the front, so the whole slice goes in.
func deserializeMessage(t *testing.T, wire []byte) *solana.Message {
	t.Helper()
	message := new(solana.Message)
	if err := message.UnmarshalWithDecoder(bin.NewBinDecoder(wire)); err != nil {
		t.Fatalf("v1 message deserializes: %v", err)
	}
	return message
}

func TestSerializedV1MessageCarriesTheV1VersionPrefix(t *testing.T) {
	wire, err := compile(t, txv1.ExampleConfig()).Message.MarshalBinary()
	if err != nil {
		t.Fatalf("message serializes: %v", err)
	}
	if wire[0] != 0x81 {
		t.Errorf("v1 messages are prefixed 0x80 | 1, got 0x%02x", wire[0])
	}
}

func TestConfigRoundTripsThroughTheWireFormat(t *testing.T) {
	config := txv1.ExampleConfig()
	wire, err := compile(t, config).Message.MarshalBinary()
	if err != nil {
		t.Fatalf("message serializes: %v", err)
	}

	decoded := deserializeMessage(t, wire)

	if !txv1.ConfigsEqual(decoded.TransactionConfig, config) {
		t.Fatalf("config did not round trip: %+v", decoded.TransactionConfig)
	}
	assertUint64(t, "priorityFee", decoded.TransactionConfig.PriorityFee, 5_000)
	assertUint32(t, "computeUnitLimit", decoded.TransactionConfig.ComputeUnitLimit, 20_000)
	assertUint32(t, "loadedAccountsDataSizeLimit", decoded.TransactionConfig.LoadedAccountsDataSizeLimit, 65_536)
	// Not 32 KB: that is the value an unset heap already resolves to, so it could
	// not distinguish a set field from an absent one.
	assertUint32(t, "heapSize", decoded.TransactionConfig.HeapSize, 65_536)
}

func TestAnEmptyConfigStillProducesAV1Message(t *testing.T) {
	wire, err := compile(t, solana.TransactionConfig{}).Message.MarshalBinary()
	if err != nil {
		t.Fatalf("message serializes: %v", err)
	}

	decoded := deserializeMessage(t, wire)

	if wire[0] != 0x81 {
		t.Errorf("an empty config is still a v1 message, got prefix 0x%02x", wire[0])
	}
	if !decoded.TransactionConfig.IsEmpty() {
		t.Errorf("expected an empty config, got %+v", decoded.TransactionConfig)
	}
	if decoded.TransactionConfig.ComputeUnitLimit != nil {
		t.Error("computeUnitLimit should be absent, not zero")
	}
	if decoded.TransactionConfig.PriorityFee != nil {
		t.Error("priorityFee should be absent, not zero")
	}
}

func TestTheConfigHoldsNoComputeBudgetInstructions(t *testing.T) {
	message := compile(t, txv1.ExampleConfig()).Message

	if len(message.Instructions) != 1 {
		t.Fatalf("the budget lives in the config, so only the transfer is compiled in; got %d instructions",
			len(message.Instructions))
	}
	for _, key := range message.AccountKeys {
		if key.Equals(computebudget.ProgramID) {
			t.Error("a v1 message must not reference the ComputeBudget program")
		}
	}
}

func TestV1MessagesHaveNoAddressTableLookups(t *testing.T) {
	message := compile(t, txv1.ExampleConfig()).Message

	if len(message.GetAddressTableLookups()) != 0 {
		t.Error("v1 has no address lookup tables")
	}

	// Proving it on the wire rather than through the accessor, which reads a
	// field the encoder never writes for v1: a byte-exact round trip leaves no
	// room for a lookup table section in either direction.
	wire, err := message.MarshalBinary()
	if err != nil {
		t.Fatalf("message serializes: %v", err)
	}
	reserialized, err := deserializeMessage(t, wire).MarshalBinary()
	if err != nil {
		t.Fatalf("decoded message re-serializes: %v", err)
	}
	if string(reserialized) != string(wire) {
		t.Error("a v1 message is exactly its header, config, addresses, and instructions")
	}
}

func TestTheConfigMaskUsesTwoBitsForThePriorityFeeAndOneForEachOtherField(t *testing.T) {
	mask := solana.TransactionConfigMaskPriorityFee | solana.TransactionConfigMaskHeapSize

	if !mask.HasPriorityFee() {
		t.Error("the priority fee bits are set")
	}
	if !mask.HasHeapSize() {
		t.Error("the heap size bit is set")
	}
	if mask.HasComputeUnitLimit() {
		t.Error("the compute unit limit bit is not set")
	}
	if mask.HasLoadedAccountsDataSize() {
		t.Error("the loaded accounts data size bit is not set")
	}
	if mask.HasUnknownBits() {
		t.Error("every bit in the mask is known")
	}
}

func TestAHalfSetPriorityFeeMaskIsInvalid(t *testing.T) {
	// The priority fee occupies two bits; setting only one is malformed rather
	// than meaning "no fee".
	mask := solana.TransactionConfigMask(0b01)
	if !mask.HasInvalidPriorityFeeBits() {
		t.Error("a half-set priority fee mask is invalid")
	}
}

func TestGRPCVersionDiscriminationKeysOnConfigNotVersioned(t *testing.T) {
	cases := []struct {
		name    string
		message *pb.Message
		want    txv1.MessageVersion
	}{
		{"v1", &pb.Message{Config: &pb.TransactionConfig{}, Versioned: true}, txv1.VersionV1},
		{"v0", &pb.Message{Versioned: true}, txv1.VersionV0},
		{"legacy", &pb.Message{Versioned: false}, txv1.VersionLegacy},
	}

	for _, test := range cases {
		if got := txv1.MessageVersionOf(test.message); got != test.want {
			t.Errorf("%s: got %s, want %s", test.name, got, test.want)
		}
	}
}

func TestAV1MessageWithAnAllUnsetConfigIsStillV1OnTheWire(t *testing.T) {
	// Every config field is optional, so a v1 message can carry a config whose
	// fields are all absent. Presence of the config, not its contents, is the
	// version signal.
	message := &pb.Message{
		Config: &pb.TransactionConfig{
			ComputeUnitLimit:            nil,
			HeapSize:                    nil,
			LoadedAccountsDataSizeLimit: nil,
			PriorityFee:                 nil,
		},
		Versioned: true,
	}

	if got := txv1.MessageVersionOf(message); got != txv1.VersionV1 {
		t.Errorf("got %s, want v1", got)
	}
}

func TestTheTallyCountsEachVersionSeparately(t *testing.T) {
	var tally txv1.VersionTally
	tally.Record(txv1.VersionLegacy)
	tally.Record(txv1.VersionV1)
	tally.Record(txv1.VersionV1)

	if tally.Legacy != 1 || tally.V0 != 0 || tally.V1 != 2 {
		t.Errorf("unexpected tally: %+v", tally)
	}
	if tally.Total() != 3 {
		t.Errorf("total: got %d, want 3", tally.Total())
	}
	if got := tally.String(); got != "legacy=1 v0=0 v1=2" {
		t.Errorf("string: got %q", got)
	}
}

func assertUint32(t *testing.T, name string, got *uint32, want uint32) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s: got nil, want %d", name, want)
	}
	if *got != want {
		t.Errorf("%s: got %d, want %d", name, *got, want)
	}
}

func assertUint64(t *testing.T, name string, got *uint64, want uint64) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s: got nil, want %d", name, want)
	}
	if *got != want {
		t.Errorf("%s: got %d, want %d", name, *got, want)
	}
}
