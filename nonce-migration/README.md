# nonce-migration

Working examples for moving off durable nonce transactions, in Rust and TypeScript: signing an action with a cold key that never goes online, relaying it later from a hot key, and reading back what happened.

The replacement is a program, not a runtime change, and two candidates exist. Anza's [programmatic signer](https://www.solana-program.com/docs/programmatic-signer) is deployed on devnet and is what these examples target today, in [`anza/`](anza). Blueshift's [Vector](https://github.com/blueshift-gg/vector) is the other and gets its own directory when it is ready. Every example runs against a local `solana-test-validator`, and the whole suite is exercised in CI.

## Why durable nonces are going away

A durable nonce transaction is the one transaction lifetime the runtime special-cases: its first instruction is `AdvanceNonceAccount`, its blockhash slot holds the nonce value, and the runtime checks both before it checks anything else. Cold-storage flows depend on that carve-out, and it is slated for deprecation once a replacement is in place ([Nonce Replacement Meta-Proposal](https://github.com/solana-foundation/solana-improvement-documents/discussions/456)). The replacement moves the job into a program: the cold key authorizes an action, a program checks the authorization and a program-owned nonce, and runs the action on the cold key's behalf.

## What changes

Today a cold key owns the funds and signs a durable nonce transaction that anyone can send later. Under the replacement:

1. The funds move to a PDA that a program controls, derived from the cold key.
2. The cold key signs a message saying "PDA, do this". No blockhash, no expiry, no fee.
3. Anyone online wraps that message in an ordinary transaction with a fresh blockhash and pays for it.
4. The program checks the signature, consumes a hash-chained nonce so the message cannot be used twice, and runs the action with the PDA as signer.

| | durable nonce | programmatic signer (Anza) |
|---|---|---|
| Where the funds live | at the cold key | at a PDA derived from the cold key |
| What the cold key signs | a whole transaction: fee payer, `AdvanceNonceAccount`, the action | one authorization message; never a transaction |
| Who pays the fee | the cold key, or a co-signer on the transaction | a hot relayer, at relay time |
| Lifetime | the nonce value in the blockhash slot | none on the artifact; the relayer's blockhash on the outer transaction |
| Nonce account | System program, 80 bytes, the cold key is the authority | SPL Nonce program, 72 bytes, the PDA is the authority |
| Next nonce value | a future blockhash; unknowable at signing time | a hash of the current value and the message; known at signing time |
| Failed action | the nonce advances and the fee is charged | everything rolls back and the artifact stays valid |
| Replay | rejected by the runtime's nonce check | rejected by the Executor program, `NonceMismatch` |
| One SOL transfer, on the wire | 303 bytes as a v1 transaction, 289 as a legacy one | 979-byte relay transaction, holding a 466-byte authorization message, holding a 156-byte execution message |
| One SOL transfer, compute units | about 300 | about 54,000 |

A pipeline that recognises durable nonce transactions by their first instruction sees none of this. The action lands inside an instruction to the signer program, three CPI levels down. The Vector column is added when that backend lands.

## What you do

Moving a cold-key workflow onto the replacement is five operations. Each backend's README names the function that performs each one.

1. **Derive the PDA from the cold key.** Nothing to create or initialize; it is a plain System address.
2. **Move the funds to it.** An ordinary transfer of SOL, and of each token balance to the PDA's associated token account.
3. **Create nonce accounts with the PDA as authority,** one per action you want in flight; anyone can pay.
4. **On the cold side, sign authorization messages.** Read the nonce value, build the action as the PDA would send it, wrap it, sign it, and hand the JSON artifact across the air gap. The next nonce value is known now, so several actions can be signed in sequence.
5. **On the hot side, relay.** Any funded key wraps the artifact in a transaction with a fresh blockhash and sends it.

Afterwards, old System nonce accounts can be closed with `WithdrawNonceAccount` to reclaim their rent.

## Before you move funds

- **A failed action can be relayed again.** If the action fails, the whole relay rolls back, nonce included, and the same artifact lands later once conditions change. A durable nonce transaction burns its nonce on failure. A deadline instruction in the action is the mitigation.
- **The relayer chooses when, with which blockhash, from which fee payer, and with what compute budget.** It cannot change the action, the amount, the recipient, or the nonce without invalidating the signature.
- **Nothing is released yet.** The Anza programs are on devnet only, under one upgrade key, unaudited; only the JavaScript client is published, at 1.0.0, and the Rust crates are placeholders. These examples pin the commit that client was built from and build the programs from it. Do not pre-sign against devnet addresses expecting them to hold.

## Quick start

```sh
cd anza
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

The `Justfile` in this directory delegates `check`, `test`, `test-live`, and `demo` to every backend.

## Examples

Run from inside [`anza/`](anza).

| What | Rust | TypeScript |
|---|---|---|
| Sign a SOL transfer with a cold key, relay it after the signing-time blockhash expires, reject a replay | `just sign-relay` | `just ts-sign-relay` |
| Sign a token withdrawal with a cold key, creating the recipient's token account on the way, and relay it from a hot key | `just token-transfer` | `just ts-token-transfer` |

Source: [`anza/rust/src/bin/`](anza/rust/src/bin) and [`anza/ts/kit/src/`](anza/ts/kit/src). The Anza README describes each example and what it prints.

## Status

These examples ship incrementally. The table above lists what exists; this list is what is coming, in order.

| Example | What it shows | Status |
|---|---|---|
| `sign-relay` | the simplest cold-signed payment, before and after | shipped |
| `token-transfer` | the same for a token balance, creating the recipient's account | shipped |
| `multi-signer` | two cold approvers sign one action on different machines, in either order | next |
| `failed-attempt` | a failed action keeps its nonce and lands later; the deadline that closes that | planned |
| `cancel` | pre-sign an action, then kill it by consuming its nonce | planned |
| `migrate` | move SOL, token balances, stake and mint authorities to the PDA with the Anza CLI | planned |
| `retire-nonces` | inventory old System nonce accounts, prove a stale pre-signed transaction is dead, reclaim rent | planned |
| `parallel`, `nonce-housekeeping` | several nonce accounts under one PDA; create, show, advance, withdraw, close | planned |
| `airgapped`, `review` | the Anza CLI across an air gap, and what an operator sees before signing | planned |
| Vector backend | the same scenarios on Blueshift's design, in `vector/` | after Anza |

Python and Go have no client on either side and are recorded as a gap, the way `transaction-v1/` records that Python has no gRPC example.

## Layout

```
anza/        Anza programmatic signer: Rust and TypeScript examples, tests, scripts, its own README and Justfile
Justfile     delegates check, test, test-live, and demo to every backend
```

Each backend is laid out like `transaction-v1/`: `rust/src/bin/` and `ts/kit/src/` hold one entry point per example, `rust/src/` and `ts/kit/src/lib/` the modules they share with matching names, `rust/tests/` and `ts/kit/test/` offline and live tests, and `scripts/` the validator and program setup.

## Additional resources

- [Nonce Replacement Meta-Proposal, SIMD discussion #456](https://github.com/solana-foundation/solana-improvement-documents/discussions/456)
- [Programmatic Signer docs](https://www.solana-program.com/docs/programmatic-signer)
- [solana-program/ed25519-programmatic-signer](https://github.com/solana-program/ed25519-programmatic-signer)
- [blueshift-gg/vector](https://github.com/blueshift-gg/vector)
