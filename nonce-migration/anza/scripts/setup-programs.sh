#!/usr/bin/env bash
# Produces the three programmatic signer programs the local validator loads.
#
# Nothing is published: the Anza repo has no releases and the crates on crates.io
# are placeholders. So the programs come from one of two places, both pinned to
# the same commit the Rust and TypeScript clients in this directory depend on:
#
#   build (default)  clone the pinned commit into .local/eps and `cargo build-sbf`
#                    each program, which is what the repo's own Makefile does
#   dump             copy the binaries deployed on devnet, which Anza redeploys
#                    from main; useful when platform-tools cannot be installed
#
# Either way the result is .local/programs/<name>.so, and validator.sh refuses to
# start without all three.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PROGRAMS="$LOCAL/programs"
REPO="https://github.com/solana-program/ed25519-programmatic-signer.git"
COMMIT="${PSIGNER_COMMIT:?set PSIGNER_COMMIT to the pinned ed25519-programmatic-signer commit}"
MODE="${1:-build}"

# Program name, program id. The names match the crates' [lib] names, which is
# what cargo build-sbf writes to target/deploy/.
NAMES=(spl_nonce_program spl_ed25519_signer_program spl_message_executor_program)
IDS=(Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR)
DIRS=(nonce/program signer/program executor/program)

# The pinned commit builds with Anza CLI 3.1, whose cargo build-sbf defaults to
# platform-tools v1.52 and SBPF v0. The CLI this directory installs defaults to
# newer platform-tools and SBPF v3, under which the Signer program fails to
# link, so the build states the toolchain the pinned commit was written for.
BUILD_ARGS=(--tools-version v1.52 --arch v0)

all_present() {
    for name in "${NAMES[@]}"; do
        [[ -s "$PROGRAMS/$name.so" ]] || return 1
    done
}

mkdir -p "$PROGRAMS"
if all_present; then
    echo "programs already in $PROGRAMS"
    exit 0
fi

case "$MODE" in
    build)
        if [[ ! -d "$LOCAL/eps/.git" ]]; then
            git clone --quiet "$REPO" "$LOCAL/eps"
        fi
        git -C "$LOCAL/eps" fetch --quiet origin "$COMMIT"
        git -C "$LOCAL/eps" checkout --quiet "$COMMIT"
        for i in "${!NAMES[@]}"; do
            echo "building ${NAMES[$i]} from ${DIRS[$i]} at ${COMMIT:0:7}"
            cargo build-sbf "${BUILD_ARGS[@]}" --manifest-path "$LOCAL/eps/${DIRS[$i]}/Cargo.toml" --sbf-out-dir "$PROGRAMS"
        done
        ;;
    dump)
        for i in "${!NAMES[@]}"; do
            echo "dumping ${NAMES[$i]} (${IDS[$i]}) from devnet"
            solana program dump --url devnet "${IDS[$i]}" "$PROGRAMS/${NAMES[$i]}.so"
        done
        ;;
    *)
        echo "usage: setup-programs.sh [build|dump]" >&2
        exit 1
        ;;
esac

all_present || {
    echo "expected ${NAMES[*]} in $PROGRAMS" >&2
    exit 1
}
echo "programs ready in $PROGRAMS"
