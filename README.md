# Gas Fee Optimizer — Pharos Agent Arena

**Challenge:** Medium / Trading & Monitoring · 100 points (+50 optional video).

**GitHub:** https://github.com/trantanlong2411-droid/Gas-Fee-Optimizer  
**Expected public Cloudflare Worker (verify deployment first):** https://gas-fee-optimizer.trantanlong2411.workers.dev/

## What is built

A non-custodial scheduling dashboard for **Pharos Mainnet (chain ID 1672)** with real gas samples, a persistent Cloudflare Durable Object scheduler, an interactive deadline simulation, and actual mined-receipt gas accounting.

1. **Track gas over time:** query `eth_chainId`, `eth_getBlockByNumber`, `eth_gasPrice` and (when supported) `eth_maxPriorityFeePerGas` from official `https://rpc.pharos.xyz`; save up to 24 hours of samples (approximately one per minute) in Durable Objects SQLite-backed storage. First live sample is collected when the public Worker is opened; there is no fabricated pre-deployment history.
2. **Accept a real signed transaction with a deadline:** paste an externally signed EIP-1559 **type-2** transaction (chain ID 1672), target effective gas fee in gwei, explicit consent and a UTC deadline 20 seconds to 24 hours in the future. Validate the actual signature and recovered sender using ethers, then store the signed bytes (not private keys) until broadcasting or cancellation. Only a holder of the unique private access token can view or cancel a job.
3. **Automatic submission:** Cloudflare Durable Object Alarms periodically check the fee cap and market quote. If the estimated effective fee is favorable, broadcast `eth_sendRawTransaction` through Pharos's official JSON-RPC; otherwise attempt broadcast when the stored deadline arrives, regardless of current quote. The sender's original maximum fee cap can **never** be altered by the scheduler. Errors result in bounded retries; the interface records submission attempts, time, trigger, accepted hash, receipt and failure status.
4. **Actual gas paid versus request-time baseline:** once the scheduled transaction is mined, fetch `eth_getTransactionReceipt`, compute `actualPaid = gasUsed * effectiveGasPrice`, and compare to `gasUsed * (estimated effective fee at request time)`. Report savings *or a higher cost*, explicitly identifying this as a **hypothetical request-time quote benchmark using the same gasUsed**, not a real alternative transaction.

The public page includes **Run deadline simulation**, which demonstrates both favorable-price and deadline-forced branches without using funds or fake mined transactions. A separate actual receipt lookup uses an independently mined historical Pharos transaction; that transaction was **not** broadcast by the optimizer, so there is no measured optimization saving for it.

## Four task requirements mapped to evidence

| Requirement | Implementation / proof |
| --- | --- |
| Tracks gas over time, history | `src/rpc.mjs` read-only live Mainnet quote, `GasScheduler.market` / 24h persistent history, public sparkline, `GET /api/market` |
| Accepts transaction and deadline, waits for price or deadline | `validateSchedule` parses a **real signed** EIP-1559 transaction, Durable Object persists job + alarm; `decision()` routes by threshold |
| Reports actual gas versus request price | `GasScheduler.receipt()` and `receiptReport()` use actual receipt gasUsed and effectiveGasPrice; tests confirm precise calculations; public independent historical receipt proof |
| Deadline attempt even with high gas | `decision()` always sends when `now >= deadlineMs`, regardless of quote availability or target; alarm schedules at deadline; deterministic tests exercise both deadline and RPC failure path |

### Safety, reliability and completeness boundaries

- **There is no absolute deadline guarantee.** Cloudflare alarms are at-least-once with retries, but their scheduling and RPC availability may be delayed. A transaction may fail to broadcast or be included later than requested. At deadline the Worker **attempts** to broadcast regardless of fee conditions; it cannot force validators to mine a transaction before a deadline.
- **An EIP-1559 signature fixes the fee caps.** Even if the scheduler broadcasts during high gas, a transaction with `maxFeePerGas` below network base fee may be rejected or remain pending. Re-signing with a higher cap is not possible for the Worker.
- **Holding signed bytes has risk.** Signed bytes are capable of authorizing the transaction; they are kept server-side pending the deadline and deleted once accepted, cancelled or permanently failed. Do not sign or schedule high-value, irreversible or deadline-critical transactions with this demo. The app never requests or stores private keys or seed phrases.
- **Hosted Pharos Chain MCP is read-only.** It disables `send_raw_transaction`, so live broadcasting uses the official `https://rpc.pharos.xyz` JSON-RPC `eth_sendRawTransaction` instead. This is not an unauthorized call to the hosted MCP. Reference: https://github.com/PharosNetwork/pharos-mcp.
- **No funded Mainnet optimizer submission was made by CI.** CI checks gas, an independently mined receipt, and probes the broadcast method with **intentionally invalid** signed bytes; unit tests use fake RPC to prove request/cancel/broadcast/deadline/retry behavior. A real paid transaction is required to verify an end-to-end optimizer-submitted receipt and savings. Do not claim one has already occurred.
- Request-time prices are observations. With EIP-1559, future block base fees and priority fees can change; waiting may save gas but no saving is guaranteed. Negative savings are reported when gas rises.
- Scheduler supports at most 25 active jobs on the shared public demo; signed raw transactions have max input size and fee/gas safety caps. The example receipt check is public and requires no secrets. Users must retain their job access token; only that token can cancel/view the job.

## Reviewer walkthrough

1. Open the public Worker; check **Live gas market** and reload after one minute. Verify the chart accumulates real readings and that `/api/market` reports block, timestamps and price.
2. In **Scheduler policy demo**, use target 29 and five samples to see a favorable-price send; target 0 to see the deadline-forced branch. The output explicitly says `SIMULATION_NO_BROADCAST` and does not claim live submission.
3. Use **Actual gas receipt proof** with the prefilled, independently mined Pharos transaction to see real gasUsed, effectiveGasPrice and actualPaid PROS. Do not report a request-time savings for this independent transaction.
4. For a true live scheduling test, supply your **own** already-signed type-2 transaction (no private key), selected deadline, gas threshold and explicit consent. Read back the protected job status and (after inclusion) actual fee benchmark. A funded live test is optional and costs real gas; none was made on behalf of the owner.
5. Review the [architecture document](ARCHITECTURE.md), [test evidence map](proof/README.md), [unit/build/live proof](https://github.com/trantanlong2411-droid/Gas-Fee-Optimizer/actions). A successful build is not proof of an actual signed transaction being mined.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Public dashboard |
| GET | `/api/health` | Version and safety/limits |
| GET | `/api/market` | Latest real gas quote and persistent 24h history |
| POST | `/api/demo` | Deterministic simulated policy ticks, not real gas |
| POST | `/api/schedule` | `{"rawTransaction":"0x02...","targetGwei":"0.1","deadlineUtc":"2026-11-08T10:00:00.000Z","consent":true}` |
| GET | `/api/jobs/<id>` | Private status; header `Authorization: Bearer <accessToken>` |
| POST | `/api/jobs/<id>/cancel` | Private cancellation before broadcast |
| GET | `/api/receipt?hash=0x...` | Verify independently mined gas fees; NOT an optimizer submission |

## Local and production

```bash
npm install
npm test
npm run build         # Wrangler dry-run; does not deploy
npm run smoke         # read-only Mainnet + invalid raw-broadcast method probe
npx wrangler deploy   # publish actual Worker
```

Cloudflare → Workers & Pages → **gas-fee-optimizer** → Settings → Builds: linked repository `trantanlong2411-droid/Gas-Fee-Optimizer`, branch `main`, deploy command `npx wrangler deploy`. The `wrangler.jsonc` Durable Object migration creates class `GasScheduler` and binding `SCHEDULER`. The public `/api/health` should match version `pharos-gas-optimizer-2026-11-07-v1`.

## Official sources

- [Pharos MCP repository — 13 read-only tools and disabled hosted broadcast](https://github.com/PharosNetwork/pharos-mcp)
- [Cloudflare Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Durable Object best practices: scheduling and idempotence](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Ethereum EIP-1559 dynamic fee transaction specification](https://eips.ethereum.org/EIPS/eip-1559)
