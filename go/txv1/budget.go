// Reading a transaction's compute budget regardless of its version.
//
// Legacy and v0 state their budget in ComputeBudget program instructions, v1 in
// the message config. BudgetOfMessage reads both.

package txv1

import (
	"encoding/binary"
	"math"

	"github.com/solana-foundation/solana-go/v2"
	computebudget "github.com/solana-foundation/solana-go/v2/programs/compute-budget"

	"github.com/solana-foundation/transaction-v1-examples/go/pb"
)

const (
	// DefaultComputeUnitsPerInstruction is the compute unit limit applied to each
	// instruction when a legacy or v0 transaction does not set one.
	DefaultComputeUnitsPerInstruction uint32 = 200_000
	// MaxComputeUnitLimit is the ceiling a legacy or v0 transaction's implicit
	// compute unit limit is clamped to.
	MaxComputeUnitLimit uint32 = 1_400_000
)

// BudgetOfMessage reads the compute budget out of a message received over gRPC,
// normalised across all three versions.
//
// v1's four config fields are the normalisation target, so the result is a
// solana.TransactionConfig whatever the version. v1 reads `config` directly;
// legacy and v0 scan ComputeBudget program instructions and convert the fee
// from a price in micro-lamports per compute unit to a total in lamports, so
// the two are comparable.
func BudgetOfMessage(message *pb.Message) solana.TransactionConfig {
	if MessageVersionOf(message) == VersionV1 {
		return budgetFromConfig(message.Config)
	}
	return budgetFromInstructions(message)
}

func budgetFromConfig(config *pb.TransactionConfig) solana.TransactionConfig {
	return solana.TransactionConfig{
		ComputeUnitLimit:            config.ComputeUnitLimit,
		HeapSize:                    config.HeapSize,
		LoadedAccountsDataSizeLimit: config.LoadedAccountsDataSizeLimit,
		PriorityFee:                 config.PriorityFee,
	}
}

func budgetFromInstructions(message *pb.Message) solana.TransactionConfig {
	var budget solana.TransactionConfig
	var priceMicroLamportsPerCU *uint64

	for _, instruction := range message.Instructions {
		if !isComputeBudgetProgram(message.AccountKeys, instruction.ProgramIdIndex) {
			continue
		}
		if len(instruction.Data) == 0 {
			continue
		}
		discriminant, operand := instruction.Data[0], instruction.Data[1:]
		switch discriminant {
		case computebudget.Instruction_RequestHeapFrame:
			budget.HeapSize = readUint32(operand)
		case computebudget.Instruction_SetComputeUnitLimit:
			budget.ComputeUnitLimit = readUint32(operand)
		case computebudget.Instruction_SetComputeUnitPrice:
			priceMicroLamportsPerCU = readUint64(operand)
		case computebudget.Instruction_SetLoadedAccountsDataSizeLimit:
			budget.LoadedAccountsDataSizeLimit = readUint32(operand)
		}
	}

	if priceMicroLamportsPerCU != nil {
		limit := DefaultComputeUnitLimit(len(message.Instructions))
		if budget.ComputeUnitLimit != nil {
			limit = *budget.ComputeUnitLimit
		}
		// The runtime rounds the total up to whole lamports.
		total := divCeil(saturatingMul(uint64(limit), *priceMicroLamportsPerCU), 1_000_000)
		budget.PriorityFee = &total
	}

	return budget
}

// DefaultComputeUnitLimit is the compute unit limit a legacy or v0 transaction
// gets when it sets none.
func DefaultComputeUnitLimit(instructionCount int) uint32 {
	if instructionCount <= 0 {
		return 0
	}
	requested := uint64(DefaultComputeUnitsPerInstruction) * uint64(instructionCount)
	if requested > uint64(MaxComputeUnitLimit) {
		return MaxComputeUnitLimit
	}
	return uint32(requested)
}

func saturatingMul(a, b uint64) uint64 {
	if a == 0 || b == 0 {
		return 0
	}
	if product := a * b; product/a == b {
		return product
	}
	return math.MaxUint64
}

func divCeil(value, divisor uint64) uint64 {
	quotient := value / divisor
	if value%divisor != 0 {
		quotient++
	}
	return quotient
}

// isComputeBudgetProgram reports whether a compiled instruction's program
// account key is the ComputeBudget program.
//
// gRPC delivers account keys as raw protobuf bytes, so any length other than 32
// cannot be an address.
func isComputeBudgetProgram(accountKeys [][]byte, programIDIndex uint32) bool {
	if programIDIndex >= uint32(len(accountKeys)) {
		return false
	}
	key := accountKeys[programIDIndex]
	if len(key) != solana.PublicKeyLength {
		return false
	}
	return solana.PublicKeyFromBytes(key).Equals(solana.ComputeBudget)
}

func readUint32(operand []byte) *uint32 {
	if len(operand) < 4 {
		return nil
	}
	value := binary.LittleEndian.Uint32(operand[:4])
	return &value
}

func readUint64(operand []byte) *uint64 {
	if len(operand) < 8 {
		return nil
	}
	value := binary.LittleEndian.Uint64(operand[:8])
	return &value
}

// ConfigsEqual reports whether two configs set the same fields to the same
// values.
//
// TransactionConfig holds pointers, so `==` compares addresses rather than
// values; and an absent field is not an explicit zero, which is exactly the
// distinction a wire round trip has to preserve.
func ConfigsEqual(a, b solana.TransactionConfig) bool {
	return equalUint64(a.PriorityFee, b.PriorityFee) &&
		equalUint32(a.ComputeUnitLimit, b.ComputeUnitLimit) &&
		equalUint32(a.LoadedAccountsDataSizeLimit, b.LoadedAccountsDataSizeLimit) &&
		equalUint32(a.HeapSize, b.HeapSize)
}

func equalUint32(a, b *uint32) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func equalUint64(a, b *uint64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
