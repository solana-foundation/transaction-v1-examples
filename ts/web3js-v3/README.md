# web3js-v3

Transaction v1 examples on `@solana/web3.js` 3.x (`^3.0.0-rc.3`), which reads
_and_ writes v1 — unlike the 1.x beta in
[`../web3js-legacy`](../web3js-legacy), whose `MessageV1.serialize` throws.

| Example                                                        | Run                               |
| -------------------------------------------------------------- | --------------------------------- |
| [`src/send-decode.ts`](src/send-decode.ts)                     | `just w3v3-send-decode`           |
| [`src/confidential-transfer.ts`](src/confidential-transfer.ts) | `just w3v3-confidential-transfer` |

`MessageV1.compile` takes the budget as a `transactionConfig`, where legacy and
v0 take Compute Budget instructions:

```ts
const message = MessageV1.compile({
    instructions,
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    transactionConfig: { computeUnitLimit: 20_000, priorityFeeLamports: 5_000n },
});
const transaction = new VersionedTransaction(message);
await transaction.sign([payer]);
await connection.sendTransaction(transaction);
```
