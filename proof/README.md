# Reviewer evidence — Gas Fee Optimizer

**Task: Medium · Trading/Monitoring · 100 points (+50 optional video).**

| Requirement | Exact source | How to verify |
| --- | --- | --- |
| Gas price tracking / recent history | `src/rpc.mjs` + `GasScheduler.market`; `/api/market` persistent history | Open public UI twice; compare recorded timestamps and gas prices, inspect block numbers |
| Submit signed tx at favorable gas or deadline | `src/policy.mjs` type-2 signed validation and decision; `src/scheduler.mjs` Durable Object alarm, send and retries | Run unit tests; interactive `/api/demo` confirms both paths; live requires a real signed tx |
| Report actual gas paid vs request price | `receiptReport` + on-chain mined receipt polling | Unit test with exact accounting and independently mined receipt lookup; full job receipt appears only after actual optimizer send mines |
| Try to meet deadline even if gas is high | `decision` explicit unconditional deadline branch | Set demo threshold to 0; target is never met, final tick triggers deadline. In actual scheduler an alarm is set at deadline, cannot guarantee inclusion |
| Public proof | `https://gas-fee-optimizer.trantanlong2411.workers.dev/` | GitHub Actions live proof and deployed check |

**Critical distinction:** public hosted Pharos MCP cannot broadcast signed transactions; actual scheduling uses official Pharos RPC `eth_sendRawTransaction` to send externally signed bytes, **not private keys**. No funded Mainnet transaction is submitted by the test suite. Do not claim full production acceptance or confirmed savings without a real optimizer-submitted on-chain receipt.

**Deadline disclaimer:** the scheduler persists deadline attempts and retries, but an external RPC outage, DO alarm delay, or signed fee cap below baseFee can prevent on-time broadcast or inclusion. The task's absolute "never misses" promise is not technically enforceable. This is disclosed on the public page.

Review workflows at https://github.com/trantanlong2411-droid/Gas-Fee-Optimizer/actions
