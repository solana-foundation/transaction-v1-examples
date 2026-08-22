#!/usr/bin/env bash
# Starts or stops a local validator with the Yellowstone geyser plugin.
#
# solana-test-validator activates every feature at genesis, so `enable_tx_v1` is
# live from slot 0 — no feature-gate wrangling is needed to send v1 traffic.
#
# Token-2022 is overridden with the released program, because the copy the
# validator bundles has confidential transfers compiled out. See
# scripts/setup-token-2022.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PID_FILE="$LOCAL/validator.pid"
LOG_FILE="$LOCAL/validator.log"
RPC_URL="http://127.0.0.1:8899"
TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

is_running() {
    solana --url "$RPC_URL" cluster-version > /dev/null 2>&1
}

# Fails unless the running validator's Token-2022 is the program at $1.
#
# The reuse path below cannot know how the validator it found was started, and a
# validator carrying the bundled Token-2022 does not announce itself: confidential
# accounts configure successfully and every transfer against them fails with
# InvalidInstructionData, naming nothing. Comparing the deployed length against
# the program this script fetched turns that into an error at startup.
check_token_2022() {
    local expected deployed
    expected="$(wc -c < "$1" | tr -d ' ')"
    deployed="$(solana --url "$RPC_URL" program show "$TOKEN_2022_PROGRAM" 2> /dev/null |
        awk '/^Data Length:/ { print $3 }')"
    if [[ "$deployed" != "$expected" ]]; then
        echo "the running validator's Token-2022 is ${deployed:-absent} bytes, not the $expected-byte" >&2
        echo "program in $1 — confidential transfers will fail on it." >&2
        echo "stop that validator and run 'just validator-start' again." >&2
        return 1
    fi
}

start() {
    token_2022_so="$("$ROOT/scripts/setup-token-2022.sh" | tail -1)"

    # Without this guard a second --reset validator would delete the ledger the
    # running one has open, while the readiness check below still passed because
    # the original is the one answering on 8899.
    if is_running; then
        echo "validator already running: $(solana --url "$RPC_URL" cluster-version)"
        check_token_2022 "$token_2022_so"
        return
    fi

    YELLOWSTONE_TAG="${YELLOWSTONE_TAG:-}" "$ROOT/scripts/setup-geyser.sh"
    mkdir -p "$LOCAL"
    solana-test-validator \
        --reset \
        --quiet \
        --ledger "$LOCAL/test-ledger" \
        --geyser-plugin-config "$LOCAL/geyser-config.json" \
        --upgradeable-program "$TOKEN_2022_PROGRAM" "$token_2022_so" none \
        > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    for _ in $(seq 1 60); do
        if is_running; then
            echo "validator ready: $(solana --url "$RPC_URL" cluster-version)"
            return 0
        fi
        sleep 1
    done
    echo "validator did not become ready; see $LOG_FILE" >&2
    tail -50 "$LOG_FILE" >&2
    exit 1
}

stop() {
    if [[ -f "$PID_FILE" ]]; then
        kill "$(cat "$PID_FILE")" 2> /dev/null || true
        rm -f "$PID_FILE"
        return 0
    fi
    # Only reached when the PID file is missing. Deliberately narrow: a blanket
    # `pkill -f solana-test-validator` would take down validators this script
    # never started, including ones belonging to other projects.
    echo "no PID file at $PID_FILE; leaving any running validator alone" >&2
}

case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    *)
        echo "usage: validator.sh [start|stop]" >&2
        exit 1
        ;;
esac
