#!/usr/bin/env bash
# Starts or stops a local validator with the Yellowstone geyser plugin.
#
# solana-test-validator activates every feature at genesis, so `enable_tx_v1` is
# live from slot 0 — no feature-gate wrangling is needed to send v1 traffic.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PID_FILE="$LOCAL/validator.pid"
LOG_FILE="$LOCAL/validator.log"
RPC_URL="http://127.0.0.1:8899"

is_running() {
    solana --url "$RPC_URL" cluster-version > /dev/null 2>&1
}

start() {
    # Without this guard a second --reset validator would delete the ledger the
    # running one has open, while the readiness check below still passed because
    # the original is the one answering on 8899.
    if is_running; then
        echo "validator already running: $(solana --url "$RPC_URL" cluster-version)"
        return 0
    fi

    YELLOWSTONE_TAG="${YELLOWSTONE_TAG:-}" "$ROOT/scripts/setup-geyser.sh"
    mkdir -p "$LOCAL"
    solana-test-validator \
        --reset \
        --quiet \
        --ledger "$LOCAL/test-ledger" \
        --geyser-plugin-config "$LOCAL/geyser-config.json" \
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
