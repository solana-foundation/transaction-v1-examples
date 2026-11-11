#!/usr/bin/env bash
# Produces the three programmatic signer programs the local validator loads.
#
# The programs are not distributed as binaries, so this clones the commit the
# Rust and TypeScript clients in this directory were built from into .local/eps
# and runs `cargo build-sbf` on each program, as the repo's own Makefile does.
# The result is .local/programs/<name>.so, and validator.sh refuses to start
# without all three.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PROGRAMS="$LOCAL/programs"
REPO="https://github.com/solana-program/ed25519-programmatic-signer.git"
COMMIT="${PSIGNER_COMMIT:?set PSIGNER_COMMIT to the pinned ed25519-programmatic-signer commit}"

# The names match the crates' [lib] names, which is what cargo build-sbf writes.
NAMES=(spl_nonce_program spl_ed25519_signer_program spl_message_executor_program)
DIRS=(nonce/program signer/program executor/program)

# The pinned commit builds with Anza CLI 3.1, whose cargo build-sbf defaults to
# platform-tools v1.52 and SBPF v0. The CLI this directory installs defaults to
# newer platform-tools and SBPF v3, under which the Signer program fails to
# link, so the build states the toolchain the pinned commit was written for.
BUILD_ARGS=(--tools-version v1.52 --arch v0)

# What the binaries in $PROGRAMS were built from. A different pin or toolchain
# rebuilds them rather than reusing what is there.
STAMP="$PROGRAMS/.source"
SOURCE="$COMMIT ${BUILD_ARGS[*]}"

all_present() {
    for name in "${NAMES[@]}"; do
        [[ -s "$PROGRAMS/$name.so" ]] || return 1
    done
}

mkdir -p "$PROGRAMS"
if all_present && [[ "$(cat "$STAMP" 2> /dev/null)" == "$SOURCE" ]]; then
    echo "programs already in $PROGRAMS"
    exit 0
fi

if [[ ! -d "$LOCAL/eps/.git" ]]; then
    git clone --quiet "$REPO" "$LOCAL/eps"
fi
git -C "$LOCAL/eps" fetch --quiet origin "$COMMIT"
git -C "$LOCAL/eps" checkout --quiet "$COMMIT"
for i in "${!NAMES[@]}"; do
    echo "building ${NAMES[$i]} from ${DIRS[$i]} at ${COMMIT:0:7}"
    cargo build-sbf "${BUILD_ARGS[@]}" --manifest-path "$LOCAL/eps/${DIRS[$i]}/Cargo.toml" --sbf-out-dir "$PROGRAMS"
done

all_present || {
    echo "expected ${NAMES[*]} in $PROGRAMS" >&2
    exit 1
}
echo "$SOURCE" > "$STAMP"
echo "programs ready in $PROGRAMS"
