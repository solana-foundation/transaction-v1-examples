# kit-plugins

Transaction v1 examples built on the `@solana/kit` plugin clients, rather than on
the `pipe`-based message builders the [`../kit`](../kit) examples use.

| Example                                                        | Run                             |
| -------------------------------------------------------------- | ------------------------------- |
| [`src/send-decode.ts`](src/send-decode.ts)                     | `just kp-send-decode`           |
| [`src/confidential-transfer.ts`](src/confidential-transfer.ts) | `just kp-confidential-transfer` |

Each one is the `ts/kit` example of the same name rebuilt on a plugin client, so
the two can be read side by side.

A plugin client is assembled with `createClient().use(...)`, and the transaction
version is a property of that assembly rather than of each call site:

```ts
const client = await createClient()
    .use(generatedSigner())
    .use(solanaLocalRpc({ transactionConfig: { priorityFeeLamports: lamports(5_000n), version: 1 } }))
    .use(airdropSigner(lamports(1_000_000_000n)));

const { context } = await client.sendTransaction([instruction]);
```

`systemProgram` and `token2022Program` are program plugins, which hang a typed
instruction builder and account fetcher for their program off the client. Every
builder they add can plan and send itself, so the fee payer, the rent lookup, the
planner and the executor are all implicit:

```ts
await client.token2022.instructions
    .mintToATA({ amount, decimals, mint, mintAuthority: client.payer, owner })
    .sendTransactions();

const account = await client.token2022.accounts.token.fetch(token);
```

Plugin order matters. `solanaLocalRpc` builds its transaction planner around a
payer, so a signer plugin has to come first; `airdropSigner` calls the `airdrop`
that `solanaLocalRpc` installs, so it has to come after; and the two program
plugins go last because they need the planning and sending `solanaLocalRpc` adds.

There is no confidential-transfer program plugin. Key derivation, proof
generation, and balance decryption still come from the plain
`@solana-program/token-2022/confidential` helpers.

`transactionConfig` is a discriminated union on `version`. Under `version: 1` it
takes `priorityFeeLamports` — a total in lamports written into the message
config — where legacy and version 0 take `microLamportsPerComputeUnit`, a
per-compute-unit price paid for with a ComputeBudget instruction.

The remaining two budget fields are not set by hand. The planner reserves
provisory limits, which is why `planTransaction` reports a compute unit limit and
a loaded accounts data size limit of `0`; the executor replaces both with values
it estimates by simulating, so the limits that come back off the wire are
measured rather than hard-coded:

```
== planned ==
  config:  {"computeUnitLimit":0,"loadedAccountsDataSizeLimit":0,"priorityFeeLamports":"5000"}

== decoded from the base64 wire bytes ==
  config:  {"priorityFeeLamports":"5000","computeUnitLimit":450,"loadedAccountsDataSizeLimit":149}
```

Pass
`transactionConfig: { estimateResourceLimits: false, version: 1 }` to keep
whatever limits the message already carries and skip the estimation simulation.
`heapSize` has no planner option; a message that needs it goes through
`setTransactionMessageConfig` as in [`../kit`](../kit).

`getTransaction` is unchanged from the rest of the repo: `client.rpc` is an
ordinary kit RPC, so reading a v1 transaction back still means passing
`maxSupportedTransactionVersion: 1` and decoding the base64 wire bytes.

## The confidential transfer

[`src/confidential-transfer.ts`](src/confidential-transfer.ts) is where the
plugin client earns its keep. The transfer is ten instructions and roughly two
kilobytes of proof bytes, so both versions of the example rely on v1's 4,096-byte
limit to keep it atomic — but they get there differently.

[`ts/kit/src/lib/confidential.ts`](../kit/src/lib/confidential.ts) hand-rolls a
`createTransactionPlanner` and a `createTransactionPlanExecutor` to run the setup
steps, roughly forty lines wiring together provisory resource limits, a blockhash
fetched at execution time, the estimator, the signer, and `sendAndConfirm`. Here
each setup step is one call, because the planner and executor the client installs
already do all of that:

```ts
await client.sendTransactions(plan);
```

That is 274 lines of setup in `ts/kit` against 150 here, and none of the
difference is the confidential transfer itself.

The transfer itself uses `sendTransaction` rather than `sendTransactions`, which
is what asserts the whole thing is atomic: it plans a _single_ transaction and
fails if the plan needs more than one. `planTransaction` first compiles the same
message without sending it, so the example can report the size it packed to:

```
== packed as one v1 transaction ==
  instructions:  10
  size:          2897 of 4096 bytes

== sent ==
  version:         1
  compute units:   247852 consumed
  config:          {"priorityFeeLamports":"5000","computeUnitLimit":262809,"loadedAccountsDataSizeLimit":634371}
```

The compute unit limit and the loaded accounts data size limit there are both
estimated by the executor. Sizing a 262,809-unit budget and a 634,371-byte data
size limit by hand is exactly the guesswork the plugin client removes.
