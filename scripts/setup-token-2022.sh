#!/usr/bin/env bash
# Puts a zk-ops build of the Token-2022 program under .local/.
#
# solana-test-validator bundles its own Token-2022, but that build has the
# `zk-ops` feature compiled out: every confidential-transfer instruction that
# moves an amount — Deposit, Withdraw, Transfer, ApplyPendingBalance — returns
# InvalidInstructionData without touching its arguments. The instructions that
# only configure an account (ConfigureAccount, ApproveAccount, EmptyAccount) are
# not behind the feature, so an account can be set up successfully and every
# transfer against it still fails.
#
# The program published with a token-2022 release is the same binary mainnet
# runs, feature included, so the validator loads that one at the Token-2022
# address instead.
set -euo pipefail

TAG="${TOKEN_2022_TAG:-program@v11.0.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"

# Keyed on the tag so bumping it fetches the new program instead of silently
# reusing whatever a previous tag left behind.
CACHE_DIR="$LOCAL/token-2022/$TAG"
SO_PATH="$CACHE_DIR/spl_token_2022.so"
mkdir -p "$CACHE_DIR"

if [[ ! -s "$SO_PATH" ]]; then
    echo "downloading spl_token_2022.so from token-2022 $TAG"
    # Downloading to a temporary name so a failed request cannot leave a
    # zero-byte file that every later run would treat as a warm cache.
    curl -sSfL -o "$SO_PATH.tmp" \
        "https://github.com/solana-program/token-2022/releases/download/${TAG//@/%40}/spl_token_2022.so"
    mv "$SO_PATH.tmp" "$SO_PATH"
fi

echo "$SO_PATH"
