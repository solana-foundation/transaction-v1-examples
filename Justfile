set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

solana_version := "4.2.1"
yellowstone_tag := "v15.1.2+solana.4.2.0"

_default:
    @just --list

# Setup

# Install Rust and TypeScript dependencies.
setup:
    cd rust && cargo fetch --locked
    cd ts && pnpm install

# Install the Anza CLI this repo is pinned to.
setup-solana:
    sh -c "$(curl -sSfL https://release.anza.xyz/v{{ solana_version }}/install)"
    solana --version

# Fetch or build the Yellowstone geyser plugin into .local/.
setup-geyser:
    YELLOWSTONE_TAG={{ yellowstone_tag }} ./scripts/setup-geyser.sh

# Formatting

fmt:
    cd rust && cargo fmt --all
    cd ts && pnpm exec oxfmt .

fmt-check:
    cd rust && cargo fmt --all --check
    cd ts && pnpm exec oxfmt --check .

# Linting

lint:
    cd rust && cargo clippy --locked --all-targets -- -D warnings
    cd ts && pnpm exec oxlint

typecheck:
    cd ts && pnpm exec tsc -p tsconfig.json --noEmit

# Testing

# Offline tests only — no validator required.
test:
    cd rust && cargo test --locked
    cd ts && pnpm exec vitest run test/wire.test.ts test/budget.test.ts

# Every test, including the ones that need a validator and geyser plugin.
test-live:
    just validator-start
    just _test-live-inner || (just validator-stop && exit 1)
    just validator-stop

_test-live-inner:
    cd rust && cargo test --locked -- --include-ignored --test-threads=1
    cd ts && TXV1_LIVE=1 pnpm exec vitest run

# Everything CI runs, minus the live tests.
check: fmt-check lint typecheck test

# Local validator

validator-start:
    YELLOWSTONE_TAG={{ yellowstone_tag }} ./scripts/validator.sh start

validator-stop:
    ./scripts/validator.sh stop

# Examples (require a running validator: `just validator-start`)

send-decode:
    cd rust && cargo run --bin send-decode

get-block slot="":
    cd rust && cargo run --bin get-block -- {{ if slot == "" { "" } else { "--slot " + slot } }}

grpc-tx-indexer:
    cd rust && cargo run --bin grpc-tx-indexer

grpc-block-indexer:
    cd rust && cargo run --bin grpc-block-indexer

ts-send-decode:
    cd ts && pnpm exec tsx src/send-decode.ts

ts-estimate:
    cd ts && pnpm exec tsx src/estimate.ts

ts-get-block slot="":
    cd ts && pnpm exec tsx src/get-block.ts {{ slot }}

ts-grpc-tx-indexer:
    cd ts && pnpm exec tsx src/grpc-tx-indexer.ts

ts-grpc-block-indexer:
    cd ts && pnpm exec tsx src/grpc-block-indexer.ts

# Run every example end to end against a fresh validator.
demo:
    just validator-start
    just _demo-inner || (just validator-stop && exit 1)
    just validator-stop

_demo-inner:
    just send-decode
    just get-block
    just ts-send-decode
    just ts-estimate
    just ts-get-block
    ./scripts/demo-indexers.sh
