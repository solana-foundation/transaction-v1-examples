// Offline tests for reading a compute budget across all three versions.

package txv1_test

import (
	"encoding/binary"
	"testing"

	"github.com/solana-foundation/solana-go/v2"
	computebudget "github.com/solana-foundation/solana-go/v2/programs/compute-budget"

	"github.com/solana-foundation/transaction-v1-examples/go/pb"
	"github.com/solana-foundation/transaction-v1-examples/go/txv1"
)

func computeBudgetInstruction(discriminant uint8, operand []byte) *pb.CompiledInstruction {
	return &pb.CompiledInstruction{
		ProgramIdIndex: 0,
		Data:           append([]byte{discriminant}, operand...),
	}
}

func leUint32(value uint32) []byte {
	operand := make([]byte, 4)
	binary.LittleEndian.PutUint32(operand, value)
	return operand
}

func leUint64(value uint64) []byte {
	operand := make([]byte, 8)
	binary.LittleEndian.PutUint64(operand, value)
	return operand
}

// instructionMessage is a legacy or v0 message whose only account key is the
// ComputeBudget program.
func instructionMessage(instructions []*pb.CompiledInstruction, versioned bool) *pb.Message {
	return &pb.Message{
		AccountKeys:  [][]byte{solana.ComputeBudget.Bytes()},
		Config:       nil,
		Instructions: instructions,
		Versioned:    versioned,
	}
}

func TestAV1BudgetIsReadStraightOffTheConfig(t *testing.T) {
	priorityFee, computeUnitLimit, heapSize := uint64(5_000), uint32(20_000), uint32(65_536)
	loadedAccounts := uint32(65_536)
	message := &pb.Message{
		Config: &pb.TransactionConfig{
			ComputeUnitLimit:            &computeUnitLimit,
			HeapSize:                    &heapSize,
			LoadedAccountsDataSizeLimit: &loadedAccounts,
			PriorityFee:                 &priorityFee,
		},
		Versioned: true,
	}

	budget := txv1.BudgetOfMessage(message)

	assertUint32(t, "computeUnitLimit", budget.ComputeUnitLimit, 20_000)
	assertUint32(t, "heapSize", budget.HeapSize, 65_536)
	assertUint32(t, "loadedAccountsDataSizeLimit", budget.LoadedAccountsDataSizeLimit, 65_536)
	assertUint64(t, "priorityFee", budget.PriorityFee, 5_000)
}

func TestAV0BudgetIsRecoveredFromComputeBudgetInstructions(t *testing.T) {
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitLimit, leUint32(20_000)),
		computeBudgetInstruction(computebudget.Instruction_SetLoadedAccountsDataSizeLimit, leUint32(65_536)),
		computeBudgetInstruction(computebudget.Instruction_RequestHeapFrame, leUint32(65_536)),
	}, true)

	budget := txv1.BudgetOfMessage(message)

	assertUint32(t, "computeUnitLimit", budget.ComputeUnitLimit, 20_000)
	assertUint32(t, "loadedAccountsDataSizeLimit", budget.LoadedAccountsDataSizeLimit, 65_536)
	assertUint32(t, "heapSize", budget.HeapSize, 65_536)
}

func TestAV0PriorityFeeIsConvertedFromMicroLamportsPerUnitToATotal(t *testing.T) {
	// 20,000 CU at 250,000 micro-lamports/CU = 5,000,000,000 micro-lamports,
	// which is the 5,000 lamports a v1 transaction would state directly.
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitLimit, leUint32(20_000)),
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitPrice, leUint64(250_000)),
	}, true)

	assertUint64(t, "priorityFee", txv1.BudgetOfMessage(message).PriorityFee, 5_000)
}

func TestAV0PriorityFeeRoundsUpToWholeLamports(t *testing.T) {
	// 1 CU at 1 micro-lamport is a millionth of a lamport, which the runtime
	// charges as one lamport rather than as zero.
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitLimit, leUint32(1)),
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitPrice, leUint64(1)),
	}, true)

	assertUint64(t, "priorityFee", txv1.BudgetOfMessage(message).PriorityFee, 1)
}

func TestAV0PriceWithoutAnExplicitLimitUsesTheImplicitDefault(t *testing.T) {
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitPrice, leUint64(1_000_000)),
	}, true)

	// One instruction, no SetComputeUnitLimit, so the limit is the 200k default
	// and a price of one lamport per CU totals 200,000 lamports.
	if got := txv1.DefaultComputeUnitLimit(1); got != 200_000 {
		t.Errorf("default limit for one instruction: got %d, want 200000", got)
	}
	assertUint64(t, "priorityFee", txv1.BudgetOfMessage(message).PriorityFee, 200_000)
}

func TestTheImplicitLimitIsClampedToTheMaximum(t *testing.T) {
	for _, instructionCount := range []int{7, 100} {
		if got := txv1.DefaultComputeUnitLimit(instructionCount); got != 1_400_000 {
			t.Errorf("%d instructions: got %d, want 1400000", instructionCount, got)
		}
	}
}

func TestATransactionWithNoBudgetInstructionsReportsNothingSet(t *testing.T) {
	budget := txv1.BudgetOfMessage(instructionMessage(nil, false))

	if !txv1.ConfigsEqual(budget, solana.TransactionConfig{}) {
		t.Errorf("expected an empty budget, got %+v", budget)
	}
}

func TestInstructionsFromOtherProgramsAreIgnored(t *testing.T) {
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitLimit, leUint32(20_000)),
	}, true)
	// Point the instruction at a different program without changing its data.
	message.AccountKeys[0] = make([]byte, solana.PublicKeyLength)

	if limit := txv1.BudgetOfMessage(message).ComputeUnitLimit; limit != nil {
		t.Errorf("only the ComputeBudget program's instructions carry a budget, got %d", *limit)
	}
}

func TestAV1MessageNeverFallsBackToScanningInstructions(t *testing.T) {
	// A v1 message carrying a ComputeBudget instruction is malformed, but the
	// config is still the only authority: silently preferring the instruction is
	// exactly the mix-up this accessor exists to prevent.
	message := instructionMessage([]*pb.CompiledInstruction{
		computeBudgetInstruction(computebudget.Instruction_SetComputeUnitLimit, leUint32(999_999)),
	}, true)
	computeUnitLimit := uint32(20_000)
	message.Config = &pb.TransactionConfig{ComputeUnitLimit: &computeUnitLimit}

	assertUint32(t, "computeUnitLimit", txv1.BudgetOfMessage(message).ComputeUnitLimit, 20_000)
}
