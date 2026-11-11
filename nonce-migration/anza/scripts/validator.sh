#!/usr/bin/env bash
# Starts or stops a local validator with the programmatic signer programs loaded.
#
# The three programs are loaded at the addresses they hold on devnet, so the
# clients' hard-coded program ids work unchanged. They are loaded as upgradeable
# programs with no authority, which is how a release would eventually look.
#
# solana-test-validator activates every feature at genesis, so transaction v1 is
# live from slot 0 and the relay transaction can be v1, as the Anza CLI sends it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PROGRAMS="$LOCAL/programs"
PID_FILE="$LOCAL/validator.pid"
LOG_FILE="$LOCAL/validator.log"
RPC_URL="http://127.0.0.1:8899"

NONCE_PROGRAM="Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB"
SIGNER_PROGRAM="EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN"
EXECUTOR_PROGRAM="ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR"

is_running() {
    solana --url "$RPC_URL" cluster-version > /dev/null 2>&1
}

# Fails unless the running validator has an executable account at $1.
#
# The reuse path below cannot know how the validator it found was started, and a
# validator without the programs fails every example with an error naming an
# unknown program rather than the missing setup.
check_program() {
    if ! solana --url "$RPC_URL" account "$1" 2> /dev/null | grep -q 'Executable: true'; then
        echo "the running validator has no program at $1." >&2
        echo "stop that validator and run 'just validator-start' again." >&2
        return 1
    fi
}

start() {
    "$ROOT/scripts/setup-programs.sh"

    # Without this guard a second --reset validator would delete the ledger the
    # running one has open, while the readiness check below still passed because
    # the original is the one answering on 8899.
    if is_running; then
        echo "validator already running: $(solana --url "$RPC_URL" cluster-version)"
        check_program "$NONCE_PROGRAM"
        check_program "$SIGNER_PROGRAM"
        check_program "$EXECUTOR_PROGRAM"
        return
    fi

    mkdir -p "$LOCAL"
    solana-test-validator \
        --reset \
        --quiet \
        --ledger "$LOCAL/test-ledger" \
        --upgradeable-program "$NONCE_PROGRAM" "$PROGRAMS/spl_nonce_program.so" none \
        --upgradeable-program "$SIGNER_PROGRAM" "$PROGRAMS/spl_ed25519_signer_program.so" none \
        --upgradeable-program "$EXECUTOR_PROGRAM" "$PROGRAMS/spl_message_executor_program.so" none \
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
    stop
    exit 1
}

stop() {
    if [[ -f "$PID_FILE" ]]; then
        # The validator may have exited and its PID been reused, so signal it
        # only if it is still a validator.
        local pid
        pid="$(cat "$PID_FILE")"
        if ps -p "$pid" -o command= 2> /dev/null | grep -q solana-test-validator; then
            kill "$pid" 2> /dev/null || true
        fi
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
