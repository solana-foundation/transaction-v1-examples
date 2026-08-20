// Package txv1 holds the shared helpers for the transaction v1 (SIMD-0385)
// examples.
//
// v1 moves the compute budget out of ComputeBudget program instructions and
// into a TransactionConfig on the message. The helpers here cover the two
// things that are easy to get wrong: identifying a v1 message, and reading its
// config.
package txv1

import "os"

// DefaultRPCURL is the JSON-RPC endpoint of a local solana-test-validator.
const DefaultRPCURL = "http://127.0.0.1:8899"

// DefaultGRPCURL is the endpoint of a local Yellowstone gRPC geyser plugin.
const DefaultGRPCURL = "http://127.0.0.1:10000"

// RPCURL returns the endpoint named by TXV1_RPC_URL, or DefaultRPCURL.
func RPCURL() string {
	return envOr("TXV1_RPC_URL", DefaultRPCURL)
}

// GRPCURL returns the endpoint named by TXV1_GRPC_URL, or DefaultGRPCURL.
func GRPCURL() string {
	return envOr("TXV1_GRPC_URL", DefaultGRPCURL)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
