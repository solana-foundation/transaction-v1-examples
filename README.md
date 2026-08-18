# transaction-v1-examples

Working examples for Solana transaction **v1** ([SIMD-0385](https://solana.com/upgrades/larger-transaction-sizes)) in Rust and TypeScript: sending, decoding, reading blocks, and indexing over Yellowstone gRPC.

Every example runs against a local `solana-test-validator` from Anza CLI 4.2.1 or Surfpool 1.5+, and the whole suite is exercised in CI.

## What v1 changes

A v1 message carries a `TransactionConfig` instead of ComputeBudget program instructions:

| | legacy / v0 | v1 |
|---|---|---|
| Compute unit limit | `SetComputeUnitLimit` instruction | `config.computeUnitLimit` |
| Priority fee | `SetComputeUnitPrice` instruction, micro-lamports **per CU** | `config.priorityFeeLamports`, **total lamports** |
| Loaded accounts cap | `SetLoadedAccountsDataSizeLimit` instruction | `config.loadedAccountsDataSizeLimit` |
| Heap size | `RequestHeapFrame` instruction | `config.heapSize` |
| Address lookup tables | v0 only | never |
| Message version prefix | `0x80` (v0) | `0x81` |

The failure mode is silence. A pipeline that derives priority fee or compute budget by scanning instructions reports **zero** for every v1 transaction and raises nothing.

## Quick start

```sh
just setup-solana     # Anza CLI 4.2.1
just setup            # Rust + TypeScript dependencies
just demo             # start a validator, run every example, shut it down
```

To keep a validator up and drive the examples yourself:

```sh
just validator-start  # local validator with the geyser plugin attached
just send-decode      # …then any example below
just validator-stop
```

`solana-test-validator` activates every feature at genesis, so the `enable_tx_v1` gate (`txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL`) is live on startup. Verify with:

```sh
solana -u l feature status txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL
```

## Examples

Each example exists in both languages and prints the same facts, except where the table says otherwise.

| What | Rust | TypeScript |
|---|---|---|
| Send a v1 transfer, read it back, decode the wire bytes | `just send-decode` | `just ts-send-decode` |
| Read a block holding v1 transactions | `just get-block` | `just ts-get-block` |
| Size the compute budget by simulation instead of hard-coding it | — | `just ts-estimate` |
| Index transactions over gRPC | `just grpc-tx-indexer` | `just ts-grpc-tx-indexer` |
| Index blocks over gRPC | `just grpc-block-indexer` | `just ts-grpc-block-indexer` |

Source: [`rust/src/bin/`](rust/src/bin) and [`ts/src/`](ts/src).

## The four ways to get v1 wrong

**1. `versioned` cannot tell v0 from v1.** Over gRPC, `Message.versioned` is `true` for both. The only signal is the presence of `config` (field 7).

```rust
match (&message.config, message.versioned) {
    (Some(_), _)     => MessageVersion::V1,
    (None, true)     => MessageVersion::V0,
    (None, false)    => MessageVersion::Legacy,
}
```

**2. Unset config fields are not defaults.** An absent `computeUnitLimit` or `loadedAccountsDataSizeLimit` resolves to **zero**, not to the generous v0-era defaults. Only `heapSize` falls back to the 32 KB default. (The 200,000-CUs-per-instruction fallback is the legacy/v0 rule and does not apply here; `solana_message::v1::TransactionConfig` is the authority.)

**3. gRPC has no opt-in and no error.** JSON-RPC gates versioned transactions behind `maxSupportedTransactionVersion` and fails loudly when the ceiling is too low — for `getBlock` it fails the *entire block*, not just the offending transaction. gRPC has no ceiling, no version field, and no server-side filter: v1 transactions simply arrive.

**4. Stale generated protobuf drops the config.** Field 7 is new. A consumer built against an older schema decodes a v1 message into something that looks exactly like v0 with no compute budget. On the TypeScript side the field arrived in `@triton-one/yellowstone-grpc` 6.0.0; every 5.x release drops it silently, so a pin like `^5.0.9` is enough to lose every v1 budget.

## Reading a budget that works for every version

The examples above isolate v1, but a real indexer has to handle all three versions with one accessor. That is [`rust/src/budget.rs`](rust/src/budget.rs) and [`ts/src/lib/budget.ts`](ts/src/lib/budget.ts): read `config` on v1, scan ComputeBudget instructions on legacy and v0, and normalise the priority fee so the two are comparable.

The fee is the part that bites. v0 states a *price* in micro-lamports per compute unit; v1 states a *total* in lamports. Comparing them means multiplying the v0 price by the compute unit limit — including the implicit `min(200_000 × instructions, 1_400_000)` limit when the transaction never set one — and rounding up:

```
20,000 CU × 250,000 micro-lamports/CU = 5,000 lamports   // v0
                                        5,000 lamports   // the v1 equivalent
```

Both gRPC indexers print this normalised budget for every transaction they see, whatever its version.

## Setting a budget across versions

Reading is one half; writing is the other, and kit's setters do not all accept the same versions. Three of the four budget fields route by version on their own, so existing code that sets them keeps working when the message becomes v1:

| Setter | legacy / v0 | v1 |
|---|---|---|
| `setTransactionMessageComputeUnitLimit` | appends a ComputeBudget instruction | writes `config.computeUnitLimit` |
| `setTransactionMessageHeapSize` | appends a ComputeBudget instruction | writes `config.heapSize` |
| `setTransactionMessageLoadedAccountsDataSizeLimit` | appends a ComputeBudget instruction | writes `config.loadedAccountsDataSizeLimit` |
| `setTransactionMessagePriorityFeeLamports` | **rejected at compile time** | writes `config.priorityFeeLamports` |
| `setTransactionMessageComputeUnitPrice` | appends a ComputeBudget instruction | **rejected at compile time** |
| `setTransactionMessageConfig` | **rejected at compile time** | writes every field it is given |

The priority fee is the one that does not port, for the same reason it complicates reading: micro-lamports per compute unit and a total in lamports are different quantities, so they get different setters and neither accepts the other's versions. Only the type system enforces this — call the wrong one and the runtime will cheerfully attach a `config` to a v0 message or a ComputeBudget instruction to a v1 one.

`setTransactionMessageConfig` merges into whatever config the message already holds, so `EXAMPLE_CONFIG` in [`ts/src/send-decode.ts`](ts/src/send-decode.ts) could equally be built up one field at a time; passing `undefined` for a field unsets it, and unsetting the last one removes `config` from the message altogether. [`ts/test/wire.test.ts`](ts/test/wire.test.ts) pins all of this down offline.

## Version requirements

| Component | Minimum | Why |
|---|---|---|
| Anza CLI / Agave | 4.2.0 | v1 support and `maxSupportedTransactionVersion: 1` |
| `solana-message` | 4.2.0 | `v1::Message` landed in 4.1.0; 4.2.0 adds the inherent `Message::serialize()` these examples call |
| `yellowstone-grpc-proto` | 12.6.0 | first release whose generated code has `Message.config` |
| yellowstone-grpc geyser | 15.1.1 | `convert_from` no longer downgrades v1 to v0 |
| `@solana/kit` | 7.1.1 | v1 codecs, config setters, `maxSupportedTransactionVersion: 1` |
| `@solana/kit` | `8.0.0-canary` | **unreleased** — see below. First version to type `createTransactionMessage({ version: 1 })` ([kit#1950](https://github.com/anza-xyz/kit/pull/1950)) |
| `@triton-one/yellowstone-grpc` | 6.0.0 | first release whose generated code has `Message.config`; 5.0.9 and earlier drop field 7 |

### These examples pin a `@solana/kit` canary

npm `latest` is 7.1.1; 8.0.0 is not published yet. `ts/package.json` pins an exact 8.0.0 canary because 8.x is the first release whose types accept version 1 in `createTransactionMessage`, which is what lets a v1 message be built through the same `pipe` as a legacy or v0 one.

On 7.1.1 every codec, setter, and decoder used here still works — only that one entry point is missing. Construct the empty message as a literal and the rest of each example is unchanged:

```ts
// @solana/kit 7.1.1: createTransactionMessage rejects version 1.
const empty = Object.freeze({ instructions: [], version: 1 } as const);
```

`yellowstone-grpc-client` 13.3.0 only requires `yellowstone-grpc-proto = "12.5.0"`, and 12.5.0 has no field 7 — so on a lockfile written before 2026-08-13 the resolver picks a proto crate that drops every v1 config without erroring. [`rust/Cargo.toml`](rust/Cargo.toml) pins 12.6.0 directly so that cannot happen, and CI runs `--locked` so a resolution change fails the build rather than drifting.

## Configuration

Every example reads its endpoints from the environment, and the Rust binaries also accept equivalent flags.

| Variable | Default | Used by |
|---|---|---|
| `TXV1_RPC_URL` | `http://127.0.0.1:8899` | all examples and tests |
| `TXV1_RPC_SUBSCRIPTIONS_URL` | `ws://127.0.0.1:8900` | TypeScript examples and tests |
| `TXV1_GRPC_URL` | `http://127.0.0.1:10000` | gRPC indexers and tests |
| `TXV1_LIVE` | unset | set to `1` to un-skip the TypeScript live tests |
| `TXV1_EXIT_AFTER_V1` | unset | stop the TypeScript transaction indexer after N v1 transactions |
| `TXV1_EXIT_AFTER_V1_BLOCKS` | unset | stop the TypeScript block indexer after N blocks holding v1 |

Rust flags: `--rpc-url`, `--grpc-url`, `--slot` (get-block), `--exit-after-v1` / `--exit-after-v1-blocks` (indexers).

## Testing

```sh
just test       # offline: wire format, codecs, version discrimination
just test-live  # everything, against a validator started for the run
just check      # what CI runs on every PR, minus the live tests
```

Offline tests need no network. Live tests start a 4.2.1 validator with the geyser plugin, send real v1 traffic, and assert on what comes back over JSON-RPC and gRPC.

CI runs both jobs on every pull request. The live job downloads the prebuilt geyser plugin published for x86_64 Linux, so it does not pay for a source build.

## Layout

```
rust/src/bin/         Rust example binaries, one per example
rust/src/             the Rust library they share
rust/tests/           offline and live tests
ts/src/               TypeScript example scripts, one per example
ts/src/lib/           the modules they share
ts/test/              offline and live tests
scripts/              validator and geyser plugin bootstrap
```

Each language directory is self-contained: `rust/` is a single Cargo package and `ts/` a single pnpm package, both driven from the root `Justfile`.

Both languages separate the runnable examples from the code they share. A file directly under `ts/src/` or in `rust/src/bin/` is an entry point — it runs top to bottom and has a `just` recipe. Everything in `ts/src/lib/` and directly under `rust/src/` is importable and free of side effects, and the two mirror each other module for module: `budget` reads a compute budget from any version, `grpc` and `rpc` wrap the two transports, `feature` checks the activation gate, and `send` builds and sends a v1 transfer.
