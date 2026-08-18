#!/usr/bin/env bash
# Puts a Yellowstone geyser plugin and its config under .local/.
#
# Linux x86_64 uses the prebuilt library published with the release. Every other
# platform (macOS in particular) has no published binary and builds from the tag,
# which takes several minutes the first time and is cached afterwards.
set -euo pipefail

TAG="${YELLOWSTONE_TAG:-v15.1.2+solana.4.2.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"

case "$(uname -s)" in
    Darwin) LIB_NAME="libyellowstone_grpc_geyser.dylib" ;;
    *) LIB_NAME="libyellowstone_grpc_geyser.so" ;;
esac

# Keyed on the tag so bumping it fetches the new plugin instead of silently
# reusing whatever a previous tag left behind.
CACHE_DIR="$LOCAL/geyser/$TAG"
LIB_PATH="$CACHE_DIR/$LIB_NAME"
mkdir -p "$CACHE_DIR"

if [[ ! -s "$LIB_PATH" ]]; then
    if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
        echo "downloading $LIB_NAME from yellowstone-grpc $TAG"
        # Downloading to a temporary name so a failed request cannot leave a
        # zero-byte file that every later run would treat as a warm cache.
        curl -sSfL -o "$LIB_PATH.tmp" \
            "https://github.com/rpcpool/yellowstone-grpc/releases/download/${TAG//+/%2B}/$LIB_NAME"
        mv "$LIB_PATH.tmp" "$LIB_PATH"
    else
        echo "no prebuilt plugin for this platform; building yellowstone-grpc $TAG from source"
        SRC_DIR="$CACHE_DIR/yellowstone-grpc"
        if [[ ! -d "$SRC_DIR" ]]; then
            git clone --depth 1 --branch "$TAG" \
                https://github.com/rpcpool/yellowstone-grpc "$SRC_DIR"
        fi
        cargo build --release -p yellowstone-grpc-geyser --manifest-path "$SRC_DIR/Cargo.toml"
        cp "$SRC_DIR/target/release/$LIB_NAME" "$LIB_PATH"
    fi
fi

cat > "$LOCAL/geyser-config.json" <<JSON
{
  "libpath": "$LIB_PATH",
  "log": { "level": "info" },
  "grpc": { "listen": [{ "address": "127.0.0.1:10000" }] }
}
JSON

echo "geyser plugin ready at $LIB_PATH"
