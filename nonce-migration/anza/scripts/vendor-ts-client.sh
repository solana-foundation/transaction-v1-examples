#!/usr/bin/env bash
# Copies the generated @solana/kit client out of the pinned Anza commit into
# ts/kit/src/client/, the way transaction-v1/scripts/gen-go-proto.sh checks in
# generated protobuf bindings.
#
# The package @solana-program/ed25519-programmatic-signer is not on npm, and a
# git dependency on clients/js would need its tsup build to run at install time,
# which pnpm does not do for a package without a `prepare` script. Vendoring the
# sources instead keeps `pnpm install` plain and makes the client's commit
# visible in the tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
REPO="https://github.com/solana-program/ed25519-programmatic-signer.git"
COMMIT="${PSIGNER_COMMIT:?set PSIGNER_COMMIT to the pinned ed25519-programmatic-signer commit}"
DEST="$ROOT/ts/kit/src/client"

if [[ ! -d "$LOCAL/eps/.git" ]]; then
    git clone --quiet "$REPO" "$LOCAL/eps"
fi
git -C "$LOCAL/eps" fetch --quiet origin "$COMMIT"
git -C "$LOCAL/eps" checkout --quiet "$COMMIT"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$LOCAL/eps/clients/js/src/generated" "$LOCAL/eps/clients/js/src/hooked" "$DEST/"
cat > "$DEST/index.ts" <<HEADER
/**
 * The @solana/kit client for the programmatic signer programs, copied from
 * clients/js/src in solana-program/ed25519-programmatic-signer at ${COMMIT:0:7}.
 *
 * Regenerate with \`just vendor-ts-client\`. Do not edit by hand.
 */

export * from './generated';
export * from './hooked';
HEADER
echo "vendored clients/js at ${COMMIT:0:7} into $DEST"
