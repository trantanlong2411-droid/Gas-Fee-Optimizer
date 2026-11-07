# Gas Fee Optimizer — Architecture

```mermaid
flowchart TD
 B[Public Browser UI] --> M[Market and history /api/market]
 M --> DO[Durable Object GasScheduler]
 DO --> READ[Pharos RPC eth_gasPrice / latest baseFee]
 READ --> HIST[(24h rolling gas history)]
 B --> DEMO[Deterministic demo /api/demo]
 B --> POST[Consent + externally signed type-2 raw transaction]
 POST --> VALIDATE{Signature, chain 1672, fee caps, deadline valid?}
 VALIDATE -->|No| ERROR[Explain refusal]
 VALIDATE -->|Yes| DO
 DO --> ALARM[Durable Object alarm]
 ALARM --> POLICY{Effective fee within target OR deadline passed?}
 POLICY -->|No| ALARM
 POLICY -->|Yes| RPCSEND[Pharos RPC eth_sendRawTransaction]
 RPCSEND -->|Error| RETRY[Record error + retry; do not claim submitted]
 RETRY --> ALARM
 RPCSEND -->|Accepted| TX[Record hash; delete raw signed bytes]
 TX --> RECEIPT[eth_getTransactionReceipt]
 RECEIPT --> PAID[Actual fee paid and request-time hypothetical benchmark]
 ```

## Real gas versus signed limits

The `eth_gasPrice` value is a network quote, not a guaranteed effective paid fee. Given a signed type-2 transaction:

```text
effectiveEstimateWei = min(maxFeePerGas, baseFeePerGas + maxPriorityFeePerGas)
```

The estimate is unavailable if base fee exceeds signed maxFeePerGas. If no EIP-1559 baseFee is exposed, the engine falls back to min(signed maxFeePerGas, network eth_gasPrice).

The rule is: when estimated effective fee is at or below user target, submit. If the deadline is reached, attempt submission even when the quote is high or unavailable. The signed fee cap is immutable. Neither the on-chain confirmation time nor a successfully mined receipt is guaranteed by the alarm. Outbound RPC failure causes a retry and is recorded as an error, **not** fake success.

### Cost measurement

Once a submitted tx is mined, the receipt provides `gasUsed` and `effectiveGasPrice`. The app calculates:

- `actualPaidWei = gasUsed * effectiveGasPrice`
- `requestEquivalentWei = gasUsed * requestTimeEstimatedEffectiveWei`
- `savingsWei = requestEquivalentWei - actualPaidWei` (possibly negative)
- `savingsPercent = savingsWei / requestEquivalentWei * 100`

This comparison **assumes the same gasUsed** at request time. It is a hypothetical benchmark, not a realized counterfactual or proof of prevented spending.

## Durable Objects

The shared SQLite-backed class `GasScheduler` stores rolling gas history and job state. It schedules an Alarm at the minimum of the next gas check and the next pending deadline. On Alarm:

1. Refresh gas quote where possible; still force deadline attempts on quote failure.
2. Process pending jobs in deadline order, setting `BROADCASTING` in storage **before** an external call.
3. Call `eth_sendRawTransaction`; validate returned tx hash matches the signature. On ambiguous errors check `eth_getTransactionByHash` by the expected hash before retry.
4. Erase signed raw bytes once accepted or after cancellation/permanent failure.
5. Poll for actual mined receipts, then stop if a transaction is mined or reverted.
6. Rearm every alarm. Retry errors are visible and eventually fail closed.

Durable Objects alarms have **at-least-once** semantics; every job is keyed by its deterministic signed tx hash, reducing duplicate scheduling. Sending an identical signed raw transaction more than once does not authorize a distinct transaction.

## Authentication and safety

No seed phrase or private key ever enters the system. The user explicitly consents to automatic broadcast of their **already-signed** transaction. A unique, high-entropy job token is created, SHA-256 hashed in storage, and required in the Authorization header to inspect/cancel. The raw signed bytes are never returned from GET endpoints or logged. The local browser retains only the access token in sessionStorage; users should keep it private.

The signed payload is itself capable of moving assets and remains sensitive. Public scheduling has rate and capacity limits. For a production-grade system, add audited custody policies, better per-user authorization, abuse prevention, upstream redundancy, alerting and robust legal/operational controls. This demo is not designed for financial-critical execution.

## What has and has not been demonstrated

- **Deterministic tests:** valid signed type-2, cross-chain/legacy refusal, favorable threshold, forced deadline, retry failure, protected status, single signed submission and receipt accounting on mock RPC.
- **Live Pharos Mainnet:** current real gas quote, independently mined transaction receipt and safe malformed signed-byte RPC-method probe.
- **Production:** public deployed history and demo, independent receipt proof, invalid signed-input rejection.
- **NOT demonstrated:** a funded optimizer-submitted transaction has not been paid, signed or mined by the test suite. Real paid savings are shown only when a user supplies and authorizes their own transaction and a receipt becomes available.

Task requirement 4 is implemented as a forced *submission attempt*, not an unqualified promise that a third-party RPC and validator will meet an external deadline.
