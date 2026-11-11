# anza

Working examples for the [programmatic signer](https://www.solana-program.com/docs/programmatic-signer), Anza's replacement for durable nonce transactions, in Rust and TypeScript: signing an action with a cold key that never goes online, relaying it later from a hot key, and reading back what happened.

Every example runs against a local `solana-test-validator` from Anza CLI 4.4.1 with the three programs loaded, and the whole suite is exercised in CI. What changes from a durable nonce transaction, the five operations a migration consists of, and what is still to come are in the [directory README](../README.md); this one is the Anza specifics.

## Terms

- **Durable nonce**: a System program nonce account and the transaction that consumes it. What you have today.
- **SPL nonce**: an account of the new SPL Nonce program, holding the value an action consumes.
- **Execution message**: the action, as the PDA would send it.
- **Authorization message**: what the cold key signs; it wraps the execution message.

The names are Anza's, as its docs and CLI use them. "Run" below means an action taking effect; "execute" is kept for the `Execute` instruction and the Executor program.

## Quick start

```sh
just setup-solana     # Anza CLI 4.4.1
just setup            # Rust and TypeScript dependencies
just setup-programs   # build the Signer, Executor, and Nonce programs from the pinned commit
just demo             # start a validator, run every example, shut it down
```

To keep a validator up and drive the examples yourself:

```sh
just validator-start  # local validator with the three programs loaded
just sign-relay       # …then any example below
just validator-stop
```

The TypeScript examples use the released [`@solana-program/ed25519-programmatic-signer`](https://www.npmjs.com/package/@solana-program/ed25519-programmatic-signer) client. The programs and the Rust client crates have no release yet, so they are pinned to the commit that client was built from, the [`clients-js@v1.0.0`](https://github.com/solana-program/ed25519-programmatic-signer/tree/clients-js%40v1.0.0) tag, named once in the `Justfile`. `just setup-programs` builds the programs from it with `cargo build-sbf`; pass `dump` to copy the binaries deployed on devnet instead, which Anza redeploys from main.

## Examples

| What | Rust | TypeScript |
|---|---|---|
| Sign a SOL transfer with a cold key, relay it after the signing-time blockhash expires, reject a replay | `just sign-relay` | `just ts-sign-relay` |
| Sign a token withdrawal with a cold key, creating the recipient's token account on the way, and relay it from a hot key | `just token-transfer` | `just ts-token-transfer` |

Source: [`rust/src/bin/`](rust/src/bin) and [`ts/kit/src/`](ts/kit/src).

The five operations in the directory README are mostly calls into the official clients; the shared modules in [`rust/src/`](rust/src) and [`ts/kit/src/lib/`](ts/kit/src/lib) hold only what those clients lack.

| Operation | Rust | TypeScript |
|---|---|---|
| Derive the PDA | `ProgrammaticSigner::derive_address` | `findProgrammaticSignerPda` |
| Move the funds | an ordinary transfer | an ordinary transfer |
| Create a nonce account | `spl_nonce::create_nonce_account` | `createNonceAccount` in `spl-nonce.ts` |
| Build the action's message | `signer::execution_message` | `executionMessage` in `signer.ts` |
| Sign on the cold side | `execute`, then `sign_and_submit` | `authorizationMessage` in `signer.ts`, then `signBytes` |
| Predict the next nonce | `spl_nonce::next_nonce` | `nextNonce` in `spl-nonce.ts` |
| Relay on the hot side | send the `Submit` instruction | `client.ed25519Signer.instructions.submit(...)` |

`sign-relay` sends the same transfer twice: first as a durable nonce transaction, then through the programmatic signer, printing what it builds as it goes. Between signing and relaying it waits for a blockhash captured at signing time to expire, about a minute on a local validator, which is the shortest proof that the signed authorization outlives one. Set `PSIGNER_SKIP_EXPIRY=true` to skip the wait.

`token-transfer` is the withdrawal most nonce users run: tokens, not SOL. The PDA holds 1,000 of a Token program mint, the kind USDC is. The cold key signs one action that creates the recipient's token account, with the PDA paying the rent, and moves 250 into it; the hot key relays it. It costs about 90,000 compute units against roughly 54,000 for a SOL transfer, most of it the account creation. It does not wait for a blockhash to expire; `sign-relay` already shows that.

## The three layers

```text
relay transaction          signed by the hot relayer, fresh blockhash, pays the fee, 979 bytes, v1
└─ Submit instruction      to the Signer program, carrying the authority signatures
   └─ authorization message    signed by the cold authority, no blockhash, no expiry, 466 bytes, v1
      └─ Execute instruction   to the Executor program
         └─ execution message      fee payer and signer are the PDA, "blockhash" is the nonce, 156 bytes, v1
            └─ the action          an ordinary System transfer from the PDA
```

The cold key signs the authorization message's bytes, which is signing a Solana message, so hardware wallets and custody systems can at least ingest it. Inside, the authorization message has exactly one instruction, `Execute`, whose data is the execution message. Inside that, the execution message names the PDA as fee payer and signer, which it could never be in a real transaction: the Signer program promotes the PDA to a signer by CPI once the authority's signature verifies, and the Executor runs the action's instructions with that promoted signer.

Every account key appears once per layer, which is where most of the 979 bytes go. [`ts/kit/src/lib/signer.ts`](ts/kit/src/lib/signer.ts) builds the two inner messages; in Rust, [`rust/src/signer.rs`](rust/src/signer.rs) builds the execution message and the client crates build the rest.

## What crosses the air gap

The cold side needs the nonce value and nothing else from the network. What it hands the relayer is the authorization message and one signature per authority. In Rust, `sign_and_submit` returns the two already packed into the `Submit` instruction; in TypeScript they are the bytes `authorizationMessage` built and the signature `signBytes` produced. Neither client defines a file format for the handoff, so serialize them however your air gap requires.

The relayer cannot change the amount, the recipient, or the nonce without invalidating the signature. It can choose when to relay, with which blockhash, from which fee payer, and with what compute budget.

The next nonce is known before anything is sent because an SPL nonce advances to `sha256(tag, program, account, current, transition signer, sha256(execution message))`, where the transition signer is a fixed PDA of the Executor program. That is what lets a chain of actions be signed up front, each valid only after the one before, and it is what the examples check after relaying.

## Common gotchas

**Two different errors are both `custom program error: 0x3`.** The Executor's `NonceMismatch` and the Signer's `InvalidSignature` share the number. A replayed authorization fails with the first, an edited one with the second. Read which program failed in the log to tell them apart; the live tests check both.

**The execution message must carry no transaction config.** The Executor rejects one that sets a compute unit limit or a priority fee, since those only mean something on a top-level transaction. Set the budget on the relay transaction instead. The Anza CLI strips a config it is handed; these examples never set one.

**Unset v1 limits are zero.** The relay transaction is v1, so its compute unit limit and loaded-accounts limit have to be stated. The TypeScript client measures both by simulating before it sends, as the Anza CLI does; the Rust examples request 200,000 compute units and 4 MB. A SOL transfer uses about 54,000 compute units and loads about 280 KB.

**The PDA cannot pay.** It is the fee payer of the execution message only as a placeholder. A real fee payer, funded and online, has to sign the relay transaction. In the Anza CLI's terms that is the configured keypair; here it is a freshly airdropped key.

**Kit and Rust compile the same instructions into different bytes.** Both order a compiled message's accounts by privilege, but within a class `@solana/kit` sorts addresses as strings, with an English collator, and the Rust compiler sorts them as bytes. With one account per class, as in a SOL transfer's execution message, the two agree; the authorization message and a token transfer have several per class and they do not. Both messages are valid and the Executor runs either, but the signature and the next nonce differ, so a chain signed in one language has to be checked by decoding its instructions, not by recompiling them. The TypeScript wire tests compare decoded instructions, not bytes, for this reason.

**The PDA pays rent, so keep it in SOL.** It is a System-owned address with lamports, so an execution message can carry `CreateAssociatedTokenAccountIdempotent` with the PDA as payer, which is how `token-transfer` creates the recipient's account. A PDA that holds only tokens cannot do that. The Signer and the Executor use the first two CPI levels, the target program gets two more; the Associated Token program's own call into System uses one of them.

**The Anza CLI dumps legacy messages.** `solana transfer --sign-only --dump-transaction-message` emits a legacy message and the Executor accepts only v1, so a CLI-built action has to be recompiled before signing. The examples build the execution message directly instead.

**The JavaScript client has no helper for three things the Rust client crates do.** `@solana-program/ed25519-programmatic-signer` has instruction builders and account decoders but nothing for the authorization message, the next nonce, or creating a nonce account. [`ts/kit/src/lib/signer.ts`](ts/kit/src/lib/signer.ts) and [`ts/kit/src/lib/spl-nonce.ts`](ts/kit/src/lib/spl-nonce.ts) fill those gaps with kit calls, and [`ts/kit/test/wire.test.ts`](ts/kit/test/wire.test.ts) checks the result against the Rust client crate.

## Version requirements

| Component | Minimum | Why |
|---|---|---|
| Anza CLI / Agave | 4.4.1 | the current stable release; v1 transactions, which the relay uses, need 4.2.0 |
| `ed25519-programmatic-signer` | commit `cf46a93` (11 Nov 2026), tag `clients-js@v1.0.0` | the Rust client crates and the programs come from this commit; they have no release of their own |
| `@solana-program/ed25519-programmatic-signer` | 1.0.0 | the generated kit client and program plugins for the three programs, built from the same commit |
| Rust | 1.93.1 | the toolchain the pinned Anza workspace builds with |
| `solana-message` | 4.4.1 | the version the pinned Anza workspace uses; one `v1::Message` type across the client crates and these examples |
| `@solana/kit` | 8.6.0 | `createTransactionMessage({ version: 1 })`, the v1 compiled-message codec, instruction plans, and `signBytes` |
| `@solana/kit-plugin-rpc`, `@solana/kit-plugin-signer` | 0.23.0 | the plugin client: a funded payer, and v1 transactions planned, sized by simulation, and sent |
| `@solana-program/system` | 0.15.0 | the System program plugin, and the System nonce helpers for the durable nonce comparison |
| `spl-token-interface` | 3.0.0 | the version the pinned Anza CLI builds `migrate token` with; `spl-associated-token-account-interface` 2.0.0 alongside it |
| `@solana-program/token` | 0.18.0 | the Token program plugin; its `createMint`, `mintToATA`, and `transferToATA` instruction plans |

## Configuration

Every example reads its settings from the environment.

| Variable | Default | Used by |
|---|---|---|
| `PSIGNER_RPC_URL` | `http://127.0.0.1:8899` | all examples and tests |
| `PSIGNER_RPC_SUBSCRIPTIONS_URL` | `ws://127.0.0.1:8900` | TypeScript examples and tests |
| `PSIGNER_SKIP_EXPIRY` | unset | set to any value to relay without waiting for the signing-time blockhash to expire |
| `PSIGNER_LIVE` | unset | set to `1` to un-skip the TypeScript live tests |
| `PSIGNER_PROGRAM_SOURCE` | `build` | set to `dump` to have `just validator-start` copy devnet's binaries instead of building |
| `PSIGNER_COMMIT` | set by `just` | the pinned commit the scripts clone |

## Testing

```sh
just test       # offline: execution message, authorization message, nonce prediction, token withdrawal
just test-live  # everything, against a validator started for the run
just check      # what CI runs on every PR, minus the live tests
```

The offline tests in both languages share one set of fixtures, frozen from the Anza client crate by [`rust/tests/wire.rs`](rust/tests/wire.rs), so the TypeScript messages are checked against the Rust client crate's, instruction for instruction. Live tests relay a cold-signed transfer, assert the nonce advanced to the predicted value, and assert that a replay and an edited message are both rejected; and relay a cold-signed token withdrawal, asserting the recipient's account was created and filled and the nonce advanced as predicted.

## Layout

```
rust/src/bin/         Rust example binaries, one per example
rust/src/             the Rust library they share
rust/tests/           offline and live tests
ts/kit/src/           @solana/kit example scripts, one per example
ts/kit/src/lib/       the modules they share
ts/kit/test/          offline and live tests
scripts/              validator and program build
```

Runnable examples are separate from the code they share. A file directly under `src/bin/` or `src/` is an entry point: it runs top to bottom and has a `just` recipe. The library modules mirror each other: `cluster` connects with a funded key and checks the programs are deployed; `spl_nonce` (`spl-nonce` in TypeScript) creates SPL nonce accounts and predicts the next value; `signer` builds the execution message, and in TypeScript the authorization message; `token` holds the token helpers the examples need, which in Rust includes the mint setup and the PDA's withdrawal; `durable_nonce` (`durable-nonce`) is the durable nonce flow for comparison.

## Additional resources

- [Programmatic Signer docs](https://www.solana-program.com/docs/programmatic-signer)
- [solana-program/ed25519-programmatic-signer](https://github.com/solana-program/ed25519-programmatic-signer)
- [Woody4618/nonce-replacement-demo](https://github.com/Woody4618/nonce-replacement-demo), the same flow driven through the Anza CLI on devnet
