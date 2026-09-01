# kit-plugins

Transaction v1 examples built on the `@solana/kit` plugin clients, rather than on
the `pipe`-based message builders the [`../kit`](../kit) examples use.

| Example                                    | Run                   |
| ------------------------------------------ | --------------------- |
| [`src/send-decode.ts`](src/send-decode.ts) | `just kp-send-decode` |

A plugin client is assembled with `createClient().use(...)`, and the transaction
version is a property of that assembly rather than of each call site:

```ts
const client = await createClient()
    .use(generatedSigner())
    .use(solanaLocalRpc({ transactionConfig: { priorityFeeLamports: lamports(5_000n), version: 1 } }))
    .use(airdropSigner(lamports(1_000_000_000n)));

const { context } = await client.sendTransaction([instruction]);
```

Plugin order matters. `solanaLocalRpc` builds its transaction planner around a
payer, so a signer plugin has to come first; `airdropSigner` calls the `airdrop`
that `solanaLocalRpc` installs, so it has to come after.

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
