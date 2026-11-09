# anza

Working examples for the [programmatic signer](https://www.solana-program.com/docs/programmatic-signer), Anza's replacement for durable nonce transactions, in Rust and TypeScript: signing an action with a cold key that never goes online, relaying it later from a hot key, and reading back what happened.

Every example runs against a local `solana-test-validator` from Anza CLI 4.4.1 with the three programs loaded, and the whole suite is exercised in CI.

## What changes

A durable nonce transaction is a real transaction the cold key signs and someone sends later. A programmatic signer action is an *authorization message* the cold key signs, which a hot relayer wraps in a transaction of its own. The funds move from the cold key to a PDA derived from it, and the PDA acts whenever the cold key has authorized it to.

| | durable nonce | programmatic signer |
|---|---|---|
| Where the funds live | at the cold key | at a PDA derived from the cold key |
| What the cold key signs | a whole transaction: fee payer, `AdvanceNonceAccount`, the action | one authorization message; never a transaction |
| Who pays the fee | the cold key, or a co-signer on the transaction | a hot relayer, at relay time |
| Lifetime | the nonce value in the blockhash slot | none on the artifact; the relayer's blockhash on the outer transaction |
| Nonce account | System program, 80 bytes, the cold key is the authority | SPL Nonce program, 72 bytes, the PDA is the authority |
| Next nonce value | a future blockhash; unknowable at signing time | a hash of the current value and the message; known at signing time |
| Failed execution | the nonce advances and the fee is charged | everything rolls back and the artifact stays valid |
| Replay | rejected by the runtime's nonce check | rejected by the Executor program, `NonceMismatch` |
| One SOL transfer, on the wire | 289 bytes | 913-byte relay transaction, holding a 433-byte authorization message, holding a 156-byte execution message |
| One SOL transfer, compute units | about 300 | about 54,000 |

A pipeline that recognises durable nonce transactions by their first instruction sees none of this. The action lands inside a `Submit` instruction to the Signer program, three CPI levels down.

## What you do

Moving a cold-key workflow onto the programmatic signer is five operations. Each names the function that performs it in [`rust/src/`](rust/src) and [`ts/kit/src/lib/`](ts/kit/src/lib).

1. **Derive the PDA from the cold key.** Nothing to create or initialize; it is a plain System address. `signer::programmatic_signer`.
2. **Move the funds to it.** An ordinary transfer of SOL, and of each token balance to the PDA's associated token account. Every example does this in its setup.
3. **Create SPL nonce accounts with the PDA as authority,** one per action you want in flight; anyone can pay. `nonce::create_nonce_account`.
4. **On the cold side, sign authorization messages.** Read the nonce value, build the action as the PDA would send it, wrap it, sign it, and hand the JSON artifact across the air gap. `signer::execution_message`, `signer::authorization_message`, `signer::sign_authorization`. The next nonce value is known now, `nonce::next_nonce`, so several actions can be signed in sequence.
5. **On the hot side, relay.** Any funded key wraps the artifact in a v1 transaction with a fresh blockhash and sends it. `signer::relay_transaction`.

Afterwards, old System nonce accounts can be closed with `WithdrawNonceAccount` to reclaim their rent; these examples leave that to the operator.

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

Nothing is published yet: the Anza repo has no releases, the crates on crates.io are placeholders, and the npm package returns 404. Everything here is pinned to one commit of [solana-program/ed25519-programmatic-signer](https://github.com/solana-program/ed25519-programmatic-signer), named once in the `Justfile`. `just setup-programs` builds the programs from it with `cargo build-sbf`; pass `dump` to copy the binaries deployed on devnet instead, which Anza redeploys from main.

## Examples

| What | Rust | TypeScript |
|---|---|---|
| Sign a SOL transfer with a cold key, relay it after the signing-time blockhash expires, reject a replay | `just sign-relay` | `just ts-sign-relay` |
| Sign a token withdrawal with a cold key, creating the recipient's token account on the way, and relay it from a hot key | `just token-transfer` | `just ts-token-transfer` |

Source: [`rust/src/bin/`](rust/src/bin) and [`ts/kit/src/`](ts/kit/src).

`sign-relay` sends the same transfer twice: first as a durable nonce transaction, then through the programmatic signer, printing each layer as it goes. Between signing and relaying it waits for a blockhash captured at signing time to expire, about a minute on a local validator, which is the shortest proof that the artifact outlives one. Set `PSIGNER_SKIP_EXPIRY=true` to skip the wait.

`token-transfer` is the withdrawal most nonce users run: tokens, not SOL. The PDA holds 1,000 of a Token program mint, the kind USDC is. The cold key signs one action that creates the recipient's token account, with the PDA paying the rent, and moves 250 into it; the hot key relays it. It costs about 90,000 compute units against roughly 54,000 for a SOL transfer, most of it the account creation. It does not wait for a blockhash to expire; `sign-relay` already shows that.

## The three layers

```text
relay transaction          signed by the hot relayer, fresh blockhash, pays the fee, 913 bytes, v1
└─ Submit instruction      to the Signer program, carrying the authority signatures
   └─ authorization message    signed by the cold authority, no blockhash, no expiry, 433 bytes, v1
      └─ Execute instruction   to the Executor program
         └─ execution message      fee payer and signer are the PDA, "blockhash" is the nonce, 156 bytes, v1
            └─ the action          an ordinary System transfer from the PDA
```

The cold key signs the authorization message's bytes, which is signing a Solana message, so hardware wallets and custody systems can at least ingest it. Inside, the authorization message has exactly one instruction, `Execute`, whose data is the execution message. Inside that, the execution message names the PDA as fee payer and signer, which it could never be in a real transaction: the Signer program promotes the PDA to a signer by CPI once the authority's signature verifies, and the Executor runs the action's instructions with that promoted signer.

Every account key appears once per layer, which is where most of the 913 bytes go. [`rust/src/signer.rs`](rust/src/signer.rs) and [`ts/kit/src/lib/signer.ts`](ts/kit/src/lib/signer.ts) build each layer in turn.

## What crosses the air gap

The cold side needs the nonce value and nothing else from the network. It produces one JSON object:

```json
{
  "authorization_message": "gQEAAwAAAAAAAAAAAAAAAAAA…",
  "signatures": ["GmaDrpp…=3JTm3k6…"],
  "consumed_nonce": "8KP1FT4ScGWBmvCpzaHd3QGGaWfewyrPpvQDTf8Vq4uF",
  "next_nonce": "7BzzPoqR58w3EYmPn1UTsAdHNy9QkFRkztb8qg5LjZW5"
}
```

The relayer cannot change the amount, the recipient, or the nonce without invalidating the signature. It can choose when to relay, with which blockhash, from which fee payer, and with what compute budget.

`next_nonce` is known before anything is sent because an SPL nonce advances to `sha256(tag, program, account, current, sha256(execution message))`. That is what lets a chain of actions be signed up front, each valid only after the one before, and it is what the examples check after relaying.

## Common gotchas

**Two different errors are both `custom program error: 0x3`.** The Executor's `NonceMismatch` and the Signer's `InvalidSignature` share the number. A replayed artifact fails with the first, an edited one with the second. Read which program failed in the log to tell them apart; the live tests check both.

**The execution message must carry no transaction config.** The Executor rejects one that sets a compute unit limit or a priority fee, since those only mean something on a top-level transaction. Set the budget on the relay transaction instead. The Anza CLI strips a config it is handed; these examples never set one.

**Unset v1 limits are zero.** The relay transaction is v1, so its compute unit limit and loaded-accounts limit have to be stated. The examples request 200,000 compute units and 4 MB; a SOL transfer uses about 54,000, and the three programs together load about 500 KB.

**The PDA cannot pay.** It is the fee payer of the execution message only as a placeholder. A real fee payer, funded and online, has to sign the relay transaction. In the Anza CLI's terms that is the configured keypair; here it is a freshly airdropped key.

**A failed action stays executable.** If the action fails, the whole relay transaction rolls back, nonce included, and the same artifact lands later once conditions change. A durable nonce transaction burns its nonce on failure. These examples do not exercise this; a deadline instruction in the execution message is the mitigation.

**Kit and Rust compile the same instructions into different bytes.** Both order a compiled message's accounts by privilege, but within a class `@solana/kit` sorts addresses as strings, with an English collator, and the Rust compiler sorts them as bytes. With one account per class, as in a SOL transfer, the two agree; a token transfer has several per class and they do not. Both messages are valid and the Executor runs either, but the signature, the artifact, and the next nonce all differ, so a chain signed in one language has to be checked by decoding its instructions, not by recompiling them. The TypeScript wire test for the token message compares instructions, not bytes, for this reason.

**The PDA pays rent, so keep it in SOL.** It is a System-owned address with lamports, so an execution message can carry `CreateAssociatedTokenAccountIdempotent` with the PDA as payer, which is how `token-transfer` creates the recipient's account. A PDA that holds only tokens cannot do that. The Signer and the Executor use the first two CPI levels, the target program gets two more; the Associated Token program's own call into System uses one of them.

**The Anza CLI dumps legacy messages.** `solana transfer --sign-only --dump-transaction-message` emits a legacy message and the Executor accepts only v1, so a CLI-built action has to be recompiled before signing. The examples build the execution message directly instead.

**`@solana-program/ed25519-programmatic-signer` is not on npm.** [`scripts/vendor-ts-client.sh`](scripts/vendor-ts-client.sh) copies the generated `@solana/kit` client out of the pinned commit into [`ts/kit/src/client/`](ts/kit/src/client), the way `transaction-v1` checks in generated protobuf bindings. The generated client has instruction builders and account decoders but no helper for the authorization message, so [`ts/kit/src/lib/signer.ts`](ts/kit/src/lib/signer.ts) lays it out by hand and [`ts/kit/test/wire.test.ts`](ts/kit/test/wire.test.ts) checks the bytes against the Rust client crate.

## Version requirements

| Component | Minimum | Why |
|---|---|---|
| Anza CLI / Agave | 4.4.1 | the current stable release; v1 transactions, which the relay uses, need 4.2.0 |
| `ed25519-programmatic-signer` | commit `f9322a0` (5 Nov 2026) | no releases exist; the client crates, the vendored TypeScript client, and the programs all come from this commit |
| Rust | 1.93.1 | the toolchain the pinned Anza workspace builds with |
| `solana-message` | 4.4.1 | the version the pinned Anza workspace uses; one `v1::Message` type across the client crates and these examples |
| `@solana/kit` | 8.6.0 | `createTransactionMessage({ version: 1 })`, the v1 compiled-message codec, and `signBytes` |
| `@solana-program/system` | 0.15.0 | the System nonce helpers for the durable nonce comparison |
| `@solana-program/loader-v3` | 0.8.0 | the vendored client's account resolver imports it |
| `spl-token-interface` | 3.0.0 | the version the pinned Anza CLI builds `migrate token` with; `spl-associated-token-account-interface` 2.0.0 alongside it |
| `@solana-program/token` | 0.18.0 | the kit Token client; its associated-token helpers cover the account the PDA creates |

## Configuration

Every example reads its endpoints from the environment; the Rust binary also accepts equivalent flags.

| Variable | Default | Used by |
|---|---|---|
| `PSIGNER_RPC_URL` | `http://127.0.0.1:8899` | all examples and tests |
| `PSIGNER_RPC_SUBSCRIPTIONS_URL` | `ws://127.0.0.1:8900` | TypeScript examples and tests |
| `PSIGNER_SKIP_EXPIRY` | unset | set to `true` to relay without waiting for the signing-time blockhash to expire |
| `PSIGNER_LIVE` | unset | set to `1` to un-skip the TypeScript live tests |
| `PSIGNER_PROGRAM_SOURCE` | `build` | set to `dump` to have `just validator-start` copy devnet's binaries instead of building |
| `PSIGNER_COMMIT` | set by `just` | the pinned commit the scripts clone |

Rust flags: `--rpc-url`, `--skip-expiry`.

## Testing

```sh
just test       # offline: PDA derivation, message layouts, nonce prediction, signature coverage, token withdrawal
just test-live  # everything, against a validator started for the run
just check      # what CI runs on every PR, minus the live tests
```

The offline tests in both languages share one set of fixtures, frozen from the Anza client crate by [`rust/tests/wire.rs`](rust/tests/wire.rs), so the TypeScript port of the authorization message is checked byte for byte. Live tests relay a cold-signed transfer, assert the nonce advanced to the predicted value, and assert that a replay and an edited message are both rejected; and relay a cold-signed token withdrawal, asserting the recipient's account was created and filled and the nonce advanced as predicted.

## Layout

```
rust/src/bin/         Rust example binaries, one per example
rust/src/             the Rust library they share
rust/tests/           offline and live tests
ts/kit/src/           @solana/kit example scripts, one per example
ts/kit/src/lib/       the modules they share
ts/kit/src/client/    the generated @solana/kit client, vendored from the pinned commit
ts/kit/test/          offline and live tests
scripts/              validator, program build, and client vendoring
```

Runnable examples are separate from the code they share. A file directly under `src/bin/` or `src/` is an entry point: it runs top to bottom and has a `just` recipe. The library modules mirror each other: `cluster` connects, funds, and checks the programs are deployed; `nonce` creates and reads SPL nonce accounts and predicts the next value; `signer` builds, signs, and relays the three layers; `token` creates a mint and token accounts, reads balances, and builds the PDA's withdrawal; `legacy` is the durable nonce flow for comparison.

## Additional resources

- [Programmatic Signer docs](https://www.solana-program.com/docs/programmatic-signer)
- [solana-program/ed25519-programmatic-signer](https://github.com/solana-program/ed25519-programmatic-signer)
- [Nonce Replacement Meta-Proposal, SIMD discussion #456](https://github.com/solana-foundation/solana-improvement-documents/discussions/456)
- [Woody4618/nonce-replacement-demo](https://github.com/Woody4618/nonce-replacement-demo), the same flow driven through the Anza CLI on devnet
