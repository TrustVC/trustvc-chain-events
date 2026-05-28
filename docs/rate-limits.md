# Avoiding RPC Rate Limits

On startup the sidecar replays historical `TitleEscrowCreated` events by fetching log batches with `eth_getLogs`. Free-tier RPC providers cap the number of blocks per request and the number of requests per second. Hitting those caps causes replay to fail with `429 Too Many Requests` errors and forces retries.

Two config fields control replay throughput. Both are per-chain inside the `chains` array.

---

## The Two Controls

### `replayBatchSize`

Maximum number of blocks fetched in a single `eth_getLogs` call.

```json
{
  "chainKey": "ethereum-sepolia",
  "rpcUrl": "wss://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
  "registryAddresses": ["0xYourRegistry"],
  "replayBatchSize": 500
}
```

Lower this when your provider returns errors like:
- `eth_getLogs block range too large`
- `Query timeout exceeded`
- `Rate limit exceeded`

### `replayDelayMs`

Millisecond pause between consecutive replay batches.

```json
{
  "replayBatchSize": 500,
  "replayDelayMs": 500
}
```

Increase this to spread requests over time and stay under per-second request limits.

---

## Recommended Settings by Provider Tier

| Provider / Tier | `replayBatchSize` | `replayDelayMs` | Notes |
|---|---|---|---|
| Alchemy / QuickNode — paid | `2000` (default) | `0` (default) | No changes needed |
| Alchemy — free (300 CU/s) | `10` | `500` | Free tier caps at 10 blocks per `eth_getLogs` |
| Infura — free | `500` | `250` | |
| Public nodes (publicnode.com) | `500` | `1000` | Shared infra — add delay |
| Self-hosted (Geth / Erigon) | `10000` | `0` | No external limits |
| Stability / Astron (HTTP poll) | `5000` | `5000` | These chains use `pollIntervalMs` instead — see below |

Start conservative and increase `replayBatchSize` until you see errors, then back off by 20%.

---

## HTTP Polling Chains

Stability and Astron use `pollIntervalMs` instead of WebSocket subscriptions. This directly controls how often the service calls `eth_blockNumber` and `eth_getLogs`.

```json
{
  "chainKey": "stability",
  "rpcUrl": "https://rpc.stabilityprotocol.com/...",
  "registryAddresses": ["0xYourRegistry"],
  "pollIntervalMs": 10000,
  "replayBatchSize": 5000,
  "replayDelayMs": 5000
}
```

Increasing `pollIntervalMs` reduces steady-state RPC calls at the cost of delivery lag.

---

## `replayFromBlock`

If you know the block your registry was deployed at, set `replayFromBlock` to skip replaying blocks before it. This is the single biggest reduction in replay RPC cost.

```json
{
  "replayFromBlock": 6123456
}
```

Without this the replay starts from block `0` — on mainnet chains that could be millions of empty batches.

---

## Database Checkpoint

When a [database](database.md) is configured, the sidecar persists a block cursor after each replay batch. On restart it resumes from where it left off rather than replaying everything from `replayFromBlock`. This makes restarts cheap regardless of batch size.

Without a database the replay starts from `replayFromBlock` on every restart.

---

## Example: Free-Tier Alchemy on Ethereum Sepolia

```json
{
  "chainKey": "ethereum-sepolia",
  "rpcUrl": "wss://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
  "registryAddresses": ["0xYourRegistry"],
  "replayFromBlock": 6000000,
  "replayBatchSize": 10,
  "replayDelayMs": 500,
  "confirmations": 1
}
```

With these settings the replay issues one `eth_getLogs` request every 500 ms covering 10 blocks at a time — well within Alchemy's free-tier compute unit budget.
