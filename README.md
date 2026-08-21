# transaction-v1-examples

Working examples for Solana transaction **v1** ([SIMD-0385](https://solana.com/upgrades/larger-transaction-sizes)) in Rust, TypeScript, Python, and Go: sending, decoding, reading blocks, and indexing over Yellowstone gRPC.

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

Existing pipelines that derives priority fees or compute budget by scanning instructions reports 0 for every v1 transaction, and raises nothing.

## Quick start

```sh
just setup-solana     # Anza CLI 4.2.1
just setup            # Rust, TypeScript, Python, and Go dependencies
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

Each example prints the same facts in every language that has it, except where the table says otherwise.

| What | Rust | TypeScript | Python | Go |
|---|---|---|---|---|
| Send a v1 transfer, read it back, decode the wire bytes | `just send-decode` | `just ts-send-decode` | `just py-send-decode` | `just go-send-decode` |
| Read a block holding v1 transactions | `just get-block` | `just ts-get-block` | `just py-get-block` | `just go-get-block` |
| Size the compute budget by simulation instead of hard-coding it | — | `just ts-estimate` | — | — |
| Send a v1 transfer under a durable nonce lifetime | — | `just ts-nonce` | — | — |
| Send a whole Token-2022 confidential transfer in one transaction | — | `just ts-confidential-transfer` | — | — |
| Index transactions over gRPC | `just grpc-tx-indexer` | `just ts-grpc-tx-indexer` | — | `just go-grpc-tx-indexer` |
| Index blocks over gRPC | `just grpc-block-indexer` | `just ts-grpc-block-indexer` | — | `just go-grpc-block-indexer` |

Source: [`rust/src/bin/`](rust/src/bin), [`ts/src/`](ts/src), [`python/examples/`](python/examples), and [`go/cmd/`](go/cmd).

Python covers the JSON-RPC basics only, and no gRPC. `solders` binds the same Rust crates the Rust examples use, so v1 support arrives with it, but Yellowstone publishes no Python client on PyPI — a Python consumer generates its own stubs, and the protobuf caveat below then applies to whichever `.proto` it generated them from.

## Do more with Larger Transactions

v1 raises the transaction size limit from **1,232 bytes to 4,096**, enabling things like the ability to send a [Token-2022 confidential transfer](https://solana.com/docs/tokens/extensions/confidential-transfer) in a single transaction. A confidential transfer is three client-generated zero-knowledge proofs, each written into its own context state account, then the transfer instruction that reads all three, then three closes to reclaim the rent. `@solana-program/token-2022` hands that back as an `InstructionPlan` for a transaction planner to split, because under the legacy limit it cannot be one transaction.

With v1, it all fits into a single transaction. [`just ts-confidential-transfer`](ts/src/confidential-transfer.ts) assembles the transfer, packs it into a single v1 message, and sends it as an atomic transaction.


### The local validator needs a different Token-2022

`solana-test-validator` bundles a Token-2022 build with the `zk-ops` feature compiled out. Every confidential-transfer instruction that moves an amount — `Deposit`, `Withdraw`, `Transfer`, `ApplyPendingBalance` — returns `InvalidInstructionData` without looking at its arguments, while the instructions that only configure an account are not behind the feature and succeed. So an account configures cleanly and every transfer against it fails, with an error that says nothing about a missing feature.

[`scripts/setup-token-2022.sh`](scripts/setup-token-2022.sh) fetches the program published with a token-2022 release — the same binary mainnet runs — and [`scripts/validator.sh`](scripts/validator.sh) loads it at the Token-2022 address instead.

That only happens for a validator this script starts. `just validator-start` reuses one that is already answering on 8899, and a validator started by hand keeps the bundled program and takes the failure above. So the script compares the deployed program's length against the one it fetched, and refuses to hand back a validator that cannot run a confidential transfer.

## Common gotchas

**Unset config fields are not defaults.** An absent `computeUnitLimit` or `loadedAccountsDataSizeLimit` resolves to **zero**. Only `heapSize` falls back to the 32 KB default. (The 200,000-CUs-per-instruction fallback is the legacy/v0 rule and does not apply here; `solana_message::v1::TransactionConfig` is the authority) - v1 transactions without config fields set will fail.

**JSON-RPC pinned at `maxSupportedTransactionVersion: 0` starts failing.** The parameter is a ceiling: ask for a v1 transaction with it set to 0 and the request errors. For `getBlock` that takes down the *entire block*, not just the offending transaction, so one v1 transaction is enough to blind a caller for that slot. Raise it to 1.

**gRPC gives no warning.** There is no equivalent parameter, no version field, and no server-side filter. Once the feature gate activates, v1 transactions show up in the stream looking like any other, so a consumer that never learned about `config` keeps running and quietly misreports them. Over gRPC, `Message.versioned` is `true` for both. The only signal is whether `config` is present.

```rust
match (&message.config, message.versioned) {
    (Some(_), _)     => MessageVersion::V1,
    (None, true)     => MessageVersion::V0,
    (None, false)    => MessageVersion::Legacy,
}
```

**Stale generated protobuf drops the config.** `config` was added to the `Message` protobuf as field 7, and protobuf clients silently discard fields their generated schema does not know about. So a consumer built before that field existed decodes a v1 message into something that looks exactly like v0 with no compute budget — no error, just missing data. On the TypeScript side the field arrived in `@triton-one/yellowstone-grpc` 6.0.0; every 5.x release drops it, so a pin like `^5.0.9` is enough to lose every v1 budget.

Go has no release that carries the field at all. yellowstone-grpc ships its Go client as pre-generated code checked into `examples/golang/proto/`, and that code was generated before field 7 was added — so on the tag whose geyser plugin *sends* the config, the Go client that ships alongside it silently drops it. [`scripts/gen-go-proto.sh`](scripts/gen-go-proto.sh) generates [`go/pb/`](go/pb) from the tag's `.proto` instead, and fails loudly if `Message.config` is missing from the result.

## Reading a budget that works for every version

The examples above isolate v1, but a real indexer has to handle all three versions with one accessor. That is [`rust/src/budget.rs`](rust/src/budget.rs), [`ts/src/lib/budget.ts`](ts/src/lib/budget.ts), and [`go/txv1/budget.go`](go/txv1/budget.go): read `config` on v1, scan ComputeBudget instructions on legacy and v0, and normalise the priority fee so the two are comparable.

The fee is the fiddly part. v0 states a *price* in micro-lamports per compute unit; v1 states a *total* in lamports. Comparing them means multiplying the v0 price by the compute unit limit — including the implicit `min(200_000 × instructions, 1_400_000)` limit when the transaction never set one — and rounding up:

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

The priority fee is the one that does not port, for the same reason it complicates reading: micro-lamports per compute unit and a total in lamports are different quantities, so they get different setters and neither accepts the other's versions. Only the type system enforces this — call the wrong one and the runtime attaches a `config` to a v0 message or a ComputeBudget instruction to a v1 one.

`setTransactionMessageConfig` merges into whatever config the message already holds, so `EXAMPLE_CONFIG` in [`ts/src/send-decode.ts`](ts/src/send-decode.ts) could equally be built up one field at a time; passing `undefined` for a field unsets it, and unsetting the last one removes `config` from the message altogether. [`ts/test/wire.test.ts`](ts/test/wire.test.ts) pins all of this down offline.

`solana-go` draws the line in the other place. `solana.TransactionV1Config(config)` both selects the v1 format and carries the whole budget, and its `With*` methods chain onto a zero `solana.TransactionConfig`, so there is one setter rather than six and no way to reach for the wrong one. What kit rejects at compile time, `solana.NewTransaction` rejects at runtime: passing a ComputeBudget instruction or an address lookup table alongside a v1 config is an error, not a silently ignored no-op. [`go/txv1/wire_test.go`](go/txv1/wire_test.go) pins the same wire-level facts down offline.

## Version requirements

| Component | Minimum | Why |
|---|---|---|
| Anza CLI / Agave | 4.2.0 | v1 support and `maxSupportedTransactionVersion: 1` |
| `solana-message` | 4.2.0 | `v1::Message` landed in 4.1.0; 4.2.0 adds the inherent `Message::serialize()` these examples call |
| `yellowstone-grpc-proto` | 12.6.0 | first release whose generated code has `Message.config` |
| yellowstone-grpc geyser | 15.1.1 | `convert_from` no longer downgrades v1 to v0 |
| `@solana/kit` | 8.0.0 | v1 codecs, config setters, and `maxSupportedTransactionVersion: 1` landed in 7.1.1; 8.0.0 is the first version to type `createTransactionMessage({ version: 1 })` ([kit#1950](https://github.com/anza-xyz/kit/pull/1950)), which is what lets a v1 message be built through the same `pipe` as a legacy or v0 one |
| `@solana-program/token-2022` | 0.15.0 | the `confidential` entry point, its instruction-plan helpers, and `solana-conf-bal/v1` key derivation |
| `@solana/zk-sdk` | 0.5.1 | the WASM proof generation the confidential helpers call |
| Token-2022 program | `program@v11.0.0` | a build with `zk-ops` enabled — see above |
| `@triton-one/yellowstone-grpc` | 6.0.0 | first release whose generated code has `Message.config`; 5.0.9 and earlier drop field 7 |
| `solders` | 0.29.0 | first release with `MessageV1`, and the first to serialize versioned messages with wincode |
| Go | 1.24 | the toolchain `solana-go` itself requires |
| `solana-go` | unreleased | **see below** — v1 lives in [solana-go#481](https://github.com/solana-foundation/solana-go/pull/481), still open |

### These examples pin `yellowstone-grpc-proto` directly

`yellowstone-grpc-client` 13.3.0 only requires `yellowstone-grpc-proto = "12.5.0"`, and 12.5.0 has no field 7 — so on a lockfile written before 2026-08-13 the resolver picks a proto crate that drops every v1 config without erroring. [`rust/Cargo.toml`](rust/Cargo.toml) pins 12.6.0 directly so that cannot happen, and CI runs `--locked` so a resolution change fails the build rather than drifting.

### These examples pin an unmerged `solana-go` branch

SIMD-0385 support is not in any `solana-go` release: it is [PR #481](https://github.com/solana-foundation/solana-go/pull/481), which adds `solana.TransactionConfig`, `solana.MessageVersionV1`, and the `solana.TransactionV1Config` build option. [`go/go.mod`](go/go.mod) therefore carries a `replace` onto the PR branch, pinned by commit. When the PR merges, the `replace` comes out and the `require` moves to the release that carries it.

## Configuration

Every example reads its endpoints from the environment, and the Rust binaries also accept equivalent flags.

| Variable | Default | Used by |
|---|---|---|
| `TXV1_RPC_URL` | `http://127.0.0.1:8899` | all examples and tests |
| `TXV1_RPC_SUBSCRIPTIONS_URL` | `ws://127.0.0.1:8900` | TypeScript examples and tests |
| `TXV1_GRPC_URL` | `http://127.0.0.1:10000` | gRPC indexers and tests |
| `TOKEN_2022_TAG` | `program@v11.0.0` | which Token-2022 release the validator scripts fetch; the `just` recipes pin it, so override with `just --set token_2022_tag …` |
| `TXV1_LIVE` | unset | set to `1` to un-skip the TypeScript and Go live tests |
| `TXV1_EXIT_AFTER_V1` | unset | stop the TypeScript or Go transaction indexer after N v1 transactions |
| `TXV1_EXIT_AFTER_V1_BLOCKS` | unset | stop the TypeScript or Go block indexer after N blocks holding v1 |

Rust flags: `--rpc-url`, `--grpc-url`, `--slot` (get-block), `--exit-after-v1` / `--exit-after-v1-blocks` (indexers). The Go commands take the same names with Go's single-dash spelling: `-rpc-url`, `-grpc-url`, `-slot`, `-exit-after-v1`, `-exit-after-v1-blocks`.

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
python/examples/      Python example scripts, one per example
python/src/txv1/      the package they share
python/tests/         offline and live tests
go/cmd/               Go example commands, one per example
go/txv1/              the Go package they share, plus offline and live tests
go/pb/                generated Yellowstone protobuf bindings
scripts/              validator, geyser plugin, Token-2022, and protobuf bootstrap
```

Each language directory is self-contained: `rust/` is a single Cargo package, `ts/` a single pnpm package, `python/` a single hatchling package, and `go/` a single Go module, all driven from the root `Justfile`.

Every language separates the runnable examples from the code they share. A file directly under `ts/src/`, in `rust/src/bin/`, in `python/examples/`, or in `go/cmd/` is an entry point — it runs top to bottom and has a `just` recipe. Everything in `ts/src/lib/`, directly under `rust/src/`, in `python/src/txv1/`, and in `go/txv1/` is importable and free of side effects, and they mirror each other module for module: `budget` reads a compute budget from any version, `grpc` and `rpc` wrap the two transports, `feature` checks the activation gate, and `send` builds and sends a v1 transfer. TypeScript adds `confidential`, which has no counterpart elsewhere. Python has no `budget` or `grpc`, since it ships no gRPC example. Go keeps them in one package, one file per module, since Go has no submodules within a package.
