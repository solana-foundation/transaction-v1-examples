#!/usr/bin/env bash
# Runs each gRPC indexer against real v1 traffic and waits for it to exit.
#
# The indexers stream forever by default, so each is given a stop condition
# (--exit-after-v1 / TXV1_EXIT_AFTER_V1) and then handed a transaction to see.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Waits for a backgrounded indexer to observe the transaction sent alongside it.
run_indexer() {
    local label="$1"
    shift

    echo "== $label =="
    "$@" &
    local indexer=$!

    # The indexer needs its subscription open before the transaction lands, or
    # it will wait forever for traffic that has already gone past.
    sleep 4
    (cd "$ROOT/rust" && cargo run --quiet --bin send-decode) > /dev/null

    if ! wait "$indexer"; then
        echo "$label did not exit cleanly" >&2
        return 1
    fi
}

run_indexer "rust grpc-tx-indexer" \
    cargo run --quiet --manifest-path "$ROOT/rust/Cargo.toml" --bin grpc-tx-indexer -- --exit-after-v1 1

run_indexer "rust grpc-block-indexer" \
    cargo run --quiet --manifest-path "$ROOT/rust/Cargo.toml" --bin grpc-block-indexer -- --exit-after-v1-blocks 1

run_indexer "ts grpc-tx-indexer" \
    env TXV1_EXIT_AFTER_V1=1 pnpm --dir "$ROOT/ts" exec tsx "$ROOT/ts/src/grpc-tx-indexer.ts"

run_indexer "ts grpc-block-indexer" \
    env TXV1_EXIT_AFTER_V1_BLOCKS=1 pnpm --dir "$ROOT/ts" exec tsx "$ROOT/ts/src/grpc-block-indexer.ts"

run_indexer "go grpc-tx-indexer" \
    go -C "$ROOT/go" run ./cmd/grpc-tx-indexer -exit-after-v1 1

run_indexer "go grpc-block-indexer" \
    go -C "$ROOT/go" run ./cmd/grpc-block-indexer -exit-after-v1-blocks 1
