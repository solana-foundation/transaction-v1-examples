# nonce-migration

Working examples for moving off durable nonce transactions, which Solana intends to deprecate once a replacement ships. Each replacement is its own directory with its own README, `Justfile`, and examples in Rust and TypeScript.

| Backend | Examples | Docs |
|---|---|---|
| Anza programmatic signer | [`anza/`](anza) | [Programmatic Signer](https://www.solana-program.com/docs/programmatic-signer) |

Run `just` from inside a backend directory. The `Justfile` here delegates `check`, `test`, `test-live`, and `demo` to every backend.

## The shared idea

Today a cold key owns the funds and signs a durable nonce transaction that anyone can send later. Under the replacement:

1. The funds move to a PDA that a program controls, derived from the cold key.
2. The cold key signs a message saying "PDA, do this". No blockhash, no expiry, no fee.
3. Anyone online wraps that message in an ordinary transaction with a fresh blockhash and pays for it.
4. The program checks the signature, consumes a hash-chained nonce so the message cannot be used twice, and runs the action with the PDA as signer.

What differs between backends is what exactly the cold key signs, where the nonce lives, how many signers one action can have, and what the relayer is allowed to change. Each backend's README opens with a table of what changes from a durable nonce transaction.
