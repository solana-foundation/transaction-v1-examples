# upgrades-examples

Working examples for Solana network upgrades, in Rust, TypeScript, Python, and Go. Companion to [solana.com/upgrades](https://solana.com/upgrades).

| Upgrade | Examples | Docs |
|---|---|---|
| Transaction v1 (SIMD-0385) | [`transaction-v1/`](transaction-v1) | [Larger Transaction Sizes](https://solana.com/upgrades/larger-transaction-sizes) |
| Durable nonce replacement | [`nonce-migration/`](nonce-migration) | [Programmatic Signer](https://www.solana-program.com/docs/programmatic-signer) |

Each directory is self-contained, with its own `Justfile` and README. Run `just` from inside it.
