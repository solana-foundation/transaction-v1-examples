#!/usr/bin/env bash
# Regenerates go/pb/ from the yellowstone-grpc protobuf definitions.
#
# The generated code is committed, so this script only runs when the pinned tag
# moves. It exists because no published Go client carries `Message.config`
# (field 7): yellowstone-grpc's own `examples/golang/proto` is checked in
# pre-generated and, as of v15.1.2, was generated before the field was added, so
# it decodes every v1 message as a v0 message with no compute budget. Generating
# from the .proto of the tag the geyser plugin is built from is what guarantees
# the field is present.
set -euo pipefail

TAG="${YELLOWSTONE_TAG:-v15.1.2+solana.4.2.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/go/pb"
GO_PACKAGE="github.com/solana-foundation/transaction-v1-examples/go/pb"

for tool in protoc git go; do
    if ! command -v "$tool" >/dev/null; then
        echo "$tool is required" >&2
        exit 1
    fi
done

# protoc resolves its plugins from PATH, and `go install` targets GOBIN.
export PATH="$PATH:$(go env GOPATH)/bin"
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q --depth 1 --branch "$TAG" \
    https://github.com/rpcpool/yellowstone-grpc.git "$WORK/yellowstone"
PROTO_DIR="$WORK/yellowstone/yellowstone-grpc-proto/proto"

# The .proto files declare yellowstone's own go_package, so every file is
# remapped onto this module's import path with an `M<file>=<path>;<package>`
# override.
mapping=()
for proto in "$PROTO_DIR"/*.proto; do
    mapping+=("--go_opt=M$(basename "$proto")=$GO_PACKAGE;pb")
    mapping+=("--go-grpc_opt=M$(basename "$proto")=$GO_PACKAGE;pb")
done

mkdir -p "$OUT"
rm -f "$OUT"/*.pb.go
protoc \
    --proto_path "$PROTO_DIR" \
    --go_out="$OUT" \
    --go_opt=paths=source_relative \
    --go-grpc_out="$OUT" \
    --go-grpc_opt=paths=source_relative \
    --experimental_allow_proto3_optional \
    "${mapping[@]}" \
    "$PROTO_DIR"/*.proto

# A missing Config field means the tag's .proto predates SIMD-0385, which would
# reproduce the exact silent data loss this repo is about.
if ! grep -qE "Config +\*TransactionConfig" "$OUT/solana-storage.pb.go"; then
    echo "generated code has no Message.config; is $TAG older than SIMD-0385?" >&2
    exit 1
fi

echo "generated $OUT from yellowstone-grpc $TAG"
