# @trustvc/webhook-events

Self-hosted Docker sidecar that streams TrustVC ETR on-chain events to your system as signed CloudEvents 1.0 webhooks.

Every lifecycle change on any ETR token in your Token Registry — mint, transfer, surrender, burn — arrives at your endpoint within seconds of chain finality. No polling. No TrustVC cloud dependency. You run it; you own it.

---

## Why Self-Hosted

| Concern | Self-hosted sidecar |
|---|---|
| Data sovereignty | Events never leave your network |
| Provider flexibility | Use your existing Alchemy/QuickNode account at your own cost tier |
| Compliance | Runs in a private VPC — no outbound except to your RPC and your webhook |
| Isolation | Each BSP has their own independent instance; no multi-tenancy |
| No TrustVC dependency | Your availability is decoupled from TrustVC infrastructure |

---

## Quick Start

### 1. Generate a signing key (one-time)

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

Or use a base64-encoded 32-byte seed (both formats are accepted):

```bash
openssl rand -base64 32   # paste output as SIGNING_PRIVATE_KEY
```

### 2. Configure

```bash
cp config.example.json config.json
# Edit config.json — set your RPC URL, registry addresses, and webhook URL
```

Create a `.env` file:

```bash
cp .env.example .env
# Set SIGNING_PRIVATE_KEY to the PEM contents or base64 seed
```

### 3. Run

#### Local Docker — Dev (hot-reload)

Bind-mounts `src/` into the container so code changes restart the server automatically. No build step needed.

```bash
npm run docker:dev
```

#### Local Docker — Production

Compiles TypeScript inside the container and runs the optimised build.

```bash
npm run docker:prod
```

#### Without Docker (local Node.js)

```bash
npm install
npm run dev   # TypeScript watch mode — no build step required
```

Or run the compiled build:

```bash
npm run build
npm start
```

#### Docker (single container, no Compose)

```bash
docker run -d \
  -v $(pwd)/config.json:/app/config.json:ro \
  -e SIGNING_PRIVATE_KEY="$(cat private.pem)" \
  -p 8080:8080 \
  --name trustvc-webhook-events \
  ghcr.io/trustvc/webhook-events:latest
```

After starting, confirm it is running:

```bash
curl http://localhost:8080/health
```

---

## Configuration

<a href="config.example.json" download="config.example.json">⬇ Download config.example.json</a>

Mount a `config.json` or point `CONFIG_PATH` at your file. Copy the example as a starting point:

```bash
cp config.example.json config.json
```

`${ENV_VAR}` placeholders are interpolated from the process environment at startup — keep secrets out of the file and pass them via `.env` or your container runtime.

Optional fields have built-in defaults and can be removed from your config entirely. Only `chainKey`, `rpcUrl`, `registryAddresses`, and `webhook.url` are mandatory.

### Chain fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `chainKey` | **Yes** | — | See [Supported Chains](#supported-chains) for valid values |
| `rpcUrl` | **Yes** | — | `wss://`, `ws://`, `https://`, or `http://` |
| `registryAddresses` | **Yes** | — | Array of EVM addresses; at least one |
| `replayFromBlock` | No | `0` | Block where your registry was deployed — omit to replay from genesis |
| `replayBatchSize` | No | `2000` | Max blocks per `eth_getLogs` call (Alchemy free tier: set to `10`) |
| `replayDelayMs` | No | `0` | Ms between replay batches — set `500`–`1000` on free-tier RPCs |
| `confirmations` | No | `1` | Blocks to wait before delivery (max `12`) |
| `pollIntervalMs` | No | chain default | HTTP-polling chains only (`stability`, `astron` variants); omit for WebSocket chains |

### Webhook fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `url` | **Yes** | — | Your downstream endpoint |
| `timeoutMs` | No | `10000` | Per-attempt timeout in ms |
| `retryAttempts` | No | `3` | Retries on failure (max `10`; `0` = no retries) |
| `retryBackoffMs` | No | `1000` | Base backoff in ms — doubles each attempt (1 s → 2 s → 4 s) |
| `headers` | No | none | Extra headers on every delivery (e.g. `X-Api-Key`) |
| `maxConcurrentDeliveries` | No | `10` | Max parallel in-flight POSTs (max `100`) |
| `maxQueueSize` | No | `10000` | In-memory event buffer — extras are dropped and logged (max `100000`) |

### Server fields

The entire `server` block is optional. Omit it to use all defaults.

| Field | Required | Default | Notes |
|---|---|---|---|
| `port` | No | `8080` | `/health` and `/metrics` bind port |
| `host` | No | `0.0.0.0` | Bind address — keep `0.0.0.0` in Docker |
| `workerProcesses` | No | `true` | Spawn each chain in its own child process for fault isolation |

### Top-level fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `chains` | **Yes** | — | Array, min 1 |
| `webhook` | **Yes** | — | |
| `server` | No | `{}` | Entire block optional |
| `logLevel` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

### Minimal config (required fields only)

```json
{
  "chains": [
    {
      "chainKey": "ethereum-sepolia",
      "rpcUrl": "wss://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}",
      "registryAddresses": ["0xYourTokenRegistryAddress"]
    }
  ],
  "webhook": {
    "url": "https://your-system.example.com/trustvc/events"
  }
}
```

### Supported Chains

| `chainKey` | Network | Transport | Approx. delivery lag |
|---|---|---|---|
| `ethereum` | Ethereum Mainnet | WebSocket | ~13 min (EIP-3675 finalized tag) |
| `ethereum-sepolia` | Ethereum Sepolia | WebSocket | ~13 min |
| `polygon` | Polygon Mainnet | WebSocket | ~4 min (128 block confirmations) |
| `polygon-amoy` | Polygon Amoy | WebSocket | ~4 min |
| `xdc` | XDC Network | WebSocket | ~4 sec (XDPoS BFT, 2 confirmations) |
| `xdc-apothem` | XDC Apothem | WebSocket | ~4 sec |
| `stability` | Stability Mainnet | HTTP polling | ~3 sec (PoA, 1 confirmation) |
| `stability-testnet` | Stability Testnet | HTTP polling | ~3 sec |
| `astron` | Astron Mainnet | HTTP polling | ~3 sec (PoA/L2, 1 confirmation) |
| `astron-testnet` | Astron Testnet | HTTP polling | ~3 sec |

Delivery lag is a property of each chain's consensus — it cannot be shortened without accepting reorg risk. The container never delivers a webhook for an unfinalized block.

### Environment Variables

| Variable | Description | Required |
|---|---|---|
| `SIGNING_PRIVATE_KEY` | Ed25519 private key — PEM or base64-encoded 32-byte seed | **Yes** |
| `CONFIG_PATH` | Path to `config.json` (default: `/app/config.json` in Docker, `./config.json` locally) | No |
| `DB_HOST` | PostgreSQL host — enables persistent storage and distributed leasing | No |
| `DB_PORT` | PostgreSQL port (default: `5432`) | No |
| `DB_NAME` | Database name (default: `trustvc`) | No |
| `DB_USER` | Database username (default: `postgres`) | No |
| `DB_PASSWORD` | Database password | No (required if DB_HOST is set) |
| `DB_POOL_MAX` | Connection pool max size (default: `5`) | No |
| `DB_POOL_MIN` | Connection pool min size (default: `1`) | No |
| `DB_LEASE_TTL_MS` | Distributed lease TTL in ms (default: `30000`) | No |
| `OTEL_ENABLED` | Set to `true` to enable OpenTelemetry traces + metrics | No |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint (default: `http://localhost:4318`) | No |
| `OTEL_SERVICE_NAME` | Service name in telemetry (default: `trustvc-webhook-events`) | No |

---

## Webhook Payload

Every event is delivered as an HTTP `POST` with:

```
Content-Type: application/json
X-TrustVC-Signature: ed25519=<base64url-signature>
```

Body follows [CloudEvents 1.0](https://cloudevents.io/):

```json
{
  "specversion": "1.0",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "source": "urn:trustvc:11155111:0xregistryaddress",
  "type": "com.trustvc.etr.holder_transfer",
  "datacontenttype": "application/json",
  "time": "2024-01-15T10:31:00.000Z",
  "subject": "1",
  "data": {
    "chainKey": "ethereum-sepolia",
    "chainId": 11155111,
    "registryAddress": "0xregistryaddress",
    "tokenId": "1",
    "blockNumber": 6123456,
    "transactionHash": "0xabcd...ef01",
    "logIndex": 0,
    "payload": { "fromHolder": "0x...", "toHolder": "0x..." }
  }
}
```

**Delivery model:** `emit()` enqueues the event immediately and returns. Actual HTTP delivery happens asynchronously via a bounded worker pool (`maxConcurrentDeliveries`). If the queue reaches `maxQueueSize` the event is dropped and counted in `failed`. On shutdown the server drains the queue (up to 20 s) before exiting.

**Idempotency key:** use `data.transactionHash + data.logIndex`. The `id` field is a fresh UUID per delivery attempt.

### Event Types

| `type` | Contract Layer | Trigger |
|---|---|---|
| `com.trustvc.etr.minted` | Registry | Token minted (`Transfer` from `0x000...000`) |
| `com.trustvc.etr.burned` | Registry | Token burned (`Transfer` to `0x000...dEaD`) |
| `com.trustvc.etr.surrendered` | Registry | Token surrendered to registry |
| `com.trustvc.etr.restored` | Registry | Token restored from registry |
| `com.trustvc.etr.registry_paused` | Registry | Registry paused |
| `com.trustvc.etr.registry_unpaused` | Registry | Registry unpaused |
| `com.trustvc.etr.escrow_created` | Factory | New TitleEscrow deployed for a token |
| `com.trustvc.etr.token_received` | TitleEscrow | Escrow took custody of the token |
| `com.trustvc.etr.nomination` | TitleEscrow | Beneficiary nominee set |
| `com.trustvc.etr.beneficiary_transfer` | TitleEscrow | Beneficiary transferred |
| `com.trustvc.etr.holder_transfer` | TitleEscrow | Holder transferred |
| `com.trustvc.etr.return_to_issuer` | TitleEscrow | Token returned to issuer |
| `com.trustvc.etr.shred` | TitleEscrow | Token permanently destroyed |
| `com.trustvc.etr.reject_transfer_beneficiary` | TitleEscrow | Beneficiary transfer rejected |
| `com.trustvc.etr.reject_transfer_holder` | TitleEscrow | Holder transfer rejected |
| `com.trustvc.etr.reject_transfer_owners` | TitleEscrow | Both roles transfer rejected simultaneously |

---

## Signature Verification

Every outbound request is signed with an **Ed25519 asymmetric key** — not HMAC.

With HMAC both sender and receiver share the same secret: if your receiver is compromised the key leaks and an attacker can forge payloads. With Ed25519 the private key lives only inside the container and is never shared. Your receiver holds only the public key, which is useless for forgery.

The `X-TrustVC-Signature` header contains the Ed25519 signature over the raw request body bytes. Verify it with the public key from the key pair you generated at setup.

### Node.js

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';

const publicKey = crypto.createPublicKey(fs.readFileSync('public.pem'));

function verifyTrustVCWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  publicKey: crypto.KeyObject,
): boolean {
  const b64 = signatureHeader.replace('ed25519=', '');
  const signature = Buffer.from(b64, 'base64url');
  return crypto.verify(null, rawBody, publicKey, signature);
}
```

### Python

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.exceptions import InvalidSignature
import base64

with open('public.pem', 'rb') as f:
    public_key = load_pem_public_key(f.read())

def verify_trustvc_webhook(raw_body: bytes, signature_header: str) -> bool:
    b64 = signature_header.removeprefix('ed25519=')
    signature = base64.urlsafe_b64decode(b64 + '==')
    try:
        public_key.verify(signature, raw_body)
        return True
    except InvalidSignature:
        return False
```

### Key Rotation

1. Generate a new Ed25519 key pair
2. Update `SIGNING_PRIVATE_KEY` to the new private key
3. Configure your receiver to accept **both old and new public keys** during the window
4. Restart the container
5. Remove the old public key from your receiver once in-flight deliveries drain (~5 minutes)

---

## API Reference

### GET /health

```bash
curl http://localhost:8080/health
```

```json
{ "status": "ok" }
```

| `status` | Meaning | HTTP |
|---|---|---|
| `ok` | All chains connected | 200 |
| `starting` | At least one chain still connecting | 200 |
| `degraded` | At least one chain permanently failed | 503 |

### Registry API

Requires `DB_HOST` to be set. All three endpoints return `503` when the database is not configured.

#### POST /registry — add a registry address at runtime

Verifies the address on-chain before persisting. The active watcher begins syncing historical events immediately — no restart required.

```bash
curl -X POST http://localhost:8080/registry \
  -H 'Content-Type: application/json' \
  -d '{"chainKey":"ethereum-sepolia","address":"0xYourRegistryAddress","fromBlock":6000000}'
```

| Field | Required | Description |
|---|---|---|
| `chainKey` | Yes | Must be a key in your running config |
| `address` | Yes | EVM address of the TrustVC Token Registry |
| `fromBlock` | No | Block to replay from (default: `0`) |

**Responses**

| HTTP | Meaning |
|---|---|
| `200` | Registry added and syncing |
| `400` | Missing/invalid `chainKey` or malformed EVM address |
| `422` | Address is not a deployed TrustVC registry on that chain |
| `503` | DB not configured |

#### GET /registries — list all persisted registries

```bash
curl http://localhost:8080/registries
```

```json
{
  "ethereum-sepolia": [
    { "address": "0xabc...", "fromBlock": 6000000 }
  ]
}
```

#### DELETE /registry/:chainKey/:address — remove a registry

```bash
curl -X DELETE http://localhost:8080/registry/ethereum-sepolia/0xabc...
```

Marks the entry inactive in the database. The in-process watcher continues until the next restart. To stop live delivery immediately, restart the container.

## Telemetry (optional)

Metrics and traces are exported via OpenTelemetry OTLP. Nothing is enabled by default — the app runs with zero-overhead no-op stubs unless you opt in.

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://<your-collector>:4318   # OTLP HTTP endpoint
OTEL_SERVICE_NAME=trustvc-webhook-events                    # default
OTEL_INSTANCE_ID=replica-1                                  # optional — defaults to hostname-pid
```

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP-compatible collector (Grafana Alloy, OpenTelemetry Collector, Grafana Cloud, Datadog, Honeycomb, etc.).

### Metrics exported

**Instance-level** (one series per replica, labeled `instance=<OTEL_INSTANCE_ID>`):

| Metric | Description |
|---|---|
| `trustvc_instance_health` | `1` = ok, `0` = degraded (a chain has permanently failed) |
| `trustvc_instance_uptime_seconds` | Process uptime — gaps indicate restarts |
| `trustvc_instance_active_chains` | Chains currently running on this replica |
| `trustvc_instance_active_workers` | Forked child worker processes |
| `trustvc_instance_total_escrows` | Total TitleEscrow subscriptions across all chains |

**Per-chain** (labeled `chain`, `transport`, `instance`):

| Metric | Description |
|---|---|
| `trustvc_chain_connected` | `1` = RPC connected, `0` = not connected |
| `trustvc_chain_last_seen_block` | Latest block processed |
| `trustvc_chain_active_escrows` | Active TitleEscrow subscriptions |
| `trustvc_chain_reconnect_attempts` | Cumulative reconnections |
| `trustvc_chain_state_changes_total` | Counter — increments on every status transition (`connecting→connected`, `connected→reconnecting`, etc.), labeled `from_status` / `to_status` |

Every state transition also emits a short **trace span** (`chain.status_changed`) visible in Tempo or any trace backend.

### Sample Grafana dashboard

A ready-to-import dashboard JSON is at [`telemetry/sample/grafana-dashboard.json`](telemetry/sample/grafana-dashboard.json). It includes:

- Fleet overview stat cards (active instances, healthy, degraded, total chains, total escrows)
- Per-instance status table + uptime trend
- Chain connection status timeline and reconnect attempts
- State-transition rate chart and cumulative transition table
- Active escrows and last-seen-block per chain

Import it via **Grafana → Dashboards → Import → Upload JSON**. Set the Prometheus data source to your Mimir / Prometheus instance.

---

## Local Development

```bash
npm install

npm run dev           # TypeScript watch mode — no Docker, no build step
npm run docker:dev    # Docker hot-reload — bind-mounts src/, restarts on change
npm run docker:prod   # Docker production — builds then runs dist/index.js

npm run build         # compile TypeScript → dist/
npm test              # unit tests (Vitest)
npm run check         # ESLint + Prettier check + tsc --noEmit
npm run fix           # auto-fix lint and format issues
```

---

## Architecture

### Request flow

```
                        ┌─────────────────────────────────────────┐
                        │            ChainOrchestrator             │
                        │                                          │
                        │  workerProcesses=true (default)          │
                        │  ┌─────────────┐  IPC   ┌────────────┐  │
                        │  │ chain-worker│◄──────►│ChainProcess│  │
                        │  │  (fork)     │        │  (parent)  │  │
                        │  └──────┬──────┘        └────────────┘  │
                        │         │                                │
                        │  workerProcesses=false                   │
                        │  ┌─────────────┐                        │
                        │  │ChainManager │                        │
                        │  └──────┬──────┘                        │
                        └─────────┼───────────────────────────────┘
                                  │
                         ProviderFactory
                                  │
                  ┌───────────────┴────────────────┐
                  │                                │
            WsTransport                     HttpTransport
            (WebSocket)                     (HTTP polling)
                  │                                │
            WsConnection                    polling loop
            (ping/reconnect)                       │
                  │                                │
                  └──────────────┬─────────────────┘
                                 │
                           ListenerStack
                                 │
                ┌────────────────┼─────────────────┐
                │                │                 │
        RegistryListener  FactoryListener   EscrowListeners
        (Transfer,         (TitleEscrow      (one per token)
         Pause/Unpause)     Created)
                │                │                 │
                └────────────────┴─────────────────┘
                                 │
                         EventNormalizer
                         (raw log → CloudEvents 1.0)
                                 │
                         WebhookEmitter
                         (bounded queue + worker pool)
                         (Ed25519-signed POST + retry)
                                 │
                         Your endpoint
```

### Two orchestration modes

| Mode | `workerProcesses` | How it works |
|---|---|---|
| Worker processes (default) | `true` | Each chain runs in a forked child process. The child sends events to the parent via IPC; the parent holds the single `WebhookEmitter` and delivery queue. A crashed worker restarts automatically after 5 s. |
| In-process | `false` | All `ChainManager` instances run in the main process. Simpler, but one chain crash can affect others. |

### Transport types

| Transport | Chains | Behaviour |
|---|---|---|
| `WsTransport` | `ethereum`, `polygon`, `xdc` (and testnets) | Opens a persistent WebSocket via `WsConnection`. Reconnects with exponential backoff (1 s base, 60 s cap). Re-attaches listeners after reconnect and replays any missed blocks. |
| `HttpTransport` | `stability`, `astron` (and testnets) | Polls `eth_blockNumber` on a configurable interval. No persistent connection; naturally fault-tolerant. |

### Webhook delivery model

`emit()` enqueues the event immediately and returns — it never blocks the chain listener. A background worker pool (size = `maxConcurrentDeliveries`) drains the queue with per-attempt timeouts and exponential retry backoff. When the process receives `SIGTERM` or `SIGINT` it:

1. Stops all chain workers (waits up to 10 s per worker before SIGKILL)
2. Drains the webhook queue (waits up to 20 s)
3. Stops the health server
4. Exits cleanly

A hard-kill timer fires at 28 s (just under Docker's default 30 s stop timeout) in case any step stalls.

### Contract layers monitored

| Layer | Contract | Events |
|---|---|---|
| Registry | `TradeTrustToken` (ERC-721) | `Transfer` (mint/burn/surrender/restore), `PauseWithRemark`, `UnpauseWithRemark` |
| Factory | `TitleEscrowFactory` | `TitleEscrowCreated` — triggers dynamic escrow subscription |
| Escrow | `TitleEscrow` (one per token) | All 9 business lifecycle events (transfer, nominate, surrender, shred, reject) |

**Escrow discovery:** On startup the sidecar replays historical `TitleEscrowCreated` events from the factory to subscribe to all existing escrows. New escrows are subscribed dynamically as they are created — no restart required. On WebSocket reconnection the replay continues from where it left off.

### Source layout

```
src/
├── index.ts                           # entry point, signal handling, graceful shutdown
├── chain-orchestrator.ts              # manages ChainManagers or child processes + distributed leasing
├── chain-manager.ts                   # thin wrapper: ProviderFactory → ITransport
├── chains/catalog.ts                  # chain definitions and address registry
├── config/                            # Zod schema + file loader + env interpolation
├── contracts/                         # ABIs and EventLog type guard
├── db/
│   ├── connection.ts                  # Sequelize singleton (openDatabase / closeDatabase / getDb)
│   ├── models/
│   │   ├── block-progress.ts          # BlockProgress model
│   │   ├── chain-lease.ts             # ChainLease model
│   │   ├── escrow.ts                  # Escrow model
│   │   └── registry-address.ts        # RegistryAddress model
│   └── repositories/
│       ├── block-repo.ts              # readBlock / writeBlock — last-seen block cursor
│       ├── escrow-repo.ts             # loadEscrows / saveEscrow / markShredded
│       ├── lease-repo.ts              # acquireLease / renewLease / releaseLease (distributed lock)
│       └── registry-repo.ts           # loadRegistries / saveRegistry / removeRegistry
├── delivery/
│   ├── event-normalizer.ts            # raw ethers log → CloudEvents 1.0
│   └── webhook-emitter.ts             # queue, worker pool, retries, drain
├── interfaces/                        # IWebhookEmitter, CloudEvent, ITransport, IPC types
├── listeners/
│   ├── listener-stack.ts              # attach/detach listeners per provider; DB-seeded on first connect
│   ├── factory-listener.ts            # replay + live subscription for TitleEscrowCreated
│   ├── registry-listener.ts           # Transfer, Pause/Unpause events
│   └── escrow-listener.ts             # all 9 TitleEscrow lifecycle events
├── rpc/
│   ├── provider-factory.ts            # selects WsTransport or HttpTransport from chainDef
│   ├── ws-transport.ts                # WebSocket lifecycle + ListenerStack coordination
│   ├── ws-connection.ts               # low-level WebSocket connect/ping/reconnect
│   ├── http-transport.ts              # HTTP polling transport + batch getLogs
│   ├── provider-state.ts              # ProviderState type + backoff formula
│   └── provider-errors.ts             # isRateLimit, isProviderDestroyed helpers
├── server/
│   ├── health-server.ts               # createHealthServer — wires Node.js http.Server + router
│   ├── router.ts                      # method+URL dispatch → controllers
│   ├── controllers/
│   │   ├── health.ts                  # GET /health
│   │   └── registry.ts                # POST /registry, GET /registries, DELETE /registry/:c/:a
│   └── utils/
│       └── request.ts                 # readBody(), sendJson()
├── signing/signing-key.ts             # Ed25519 key loading and sign()
├── telemetry/
│   ├── index.ts                       # tracer + meter exports (no-op when OTEL_ENABLED unset)
│   └── instrumentation.ts             # OTel SDK bootstrap (dynamic import, OTEL_ENABLED=true)
├── utils/
│   ├── async.ts                       # sleep()
│   ├── format.ts                      # toISOString()
│   └── eth.ts                         # toNormalizedLog()
└── workers/chain-worker.ts            # child process entry point (IPC ↔ parent)

telemetry/sample/
└── grafana-dashboard.json             # importable Grafana dashboard (Fleet + Chain health)
```

---

## Horizontal Scaling

By default the sidecar is designed as a **single-replica** service. One container per BSP is the recommended deployment. However, if you need high-availability (active–passive failover) or want to run replicas across availability zones, PostgreSQL-backed distributed leasing is built in.

### How it works

| Layer | Mechanism | Purpose |
|---|---|---|
| **Distributed lease** | `chain_leases` table — atomic `INSERT … ON CONFLICT / UPDATE WHERE expires_at < NOW()` | Ensures only one replica polls each chain at a time |
| **Block cursor** | `block_progress` table — persists last-seen block number | On restart, replay only the delta since the last checkpoint — no full rescan |
| **Escrow cache** | `escrows` table — persists discovered TitleEscrow addresses | On restart, load known escrows from DB — zero RPC escrow-discovery cost |

### Requirements before enabling

1. **PostgreSQL** (or any Sequelize-compatible SQL database — see [Environment Variables](#environment-variables))

No change to `config.json` is needed. With `workerProcesses: true` (the default) each child process opens its own independent DB connection, so the distributed lease and block-cursor features work correctly in both in-process and worker-process modes.

### Database environment variables

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | *(unset — no DB)* | Set this to enable all DB features |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `trustvc` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | *(empty)* | Database password |
| `DB_POOL_MAX` | `5` | Max connections in the pool |
| `DB_POOL_MIN` | `1` | Min connections in the pool |
| `DB_LEASE_TTL_MS` | `30000` | Lease TTL in ms — set to at least `3 × pollIntervalMs` |

If `DB_HOST` is not set the container starts normally with no database dependency — all DB features are silently skipped.

### Docker Compose (multi-replica example)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: trustvc
      POSTGRES_USER: trustvc
      POSTGRES_PASSWORD: secret
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U trustvc"]
      interval: 5s
      retries: 5

  webhook-events-1:
    image: ghcr.io/trustvc/webhook-events:latest
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./config.json:/app/config.json:ro
    environment:
      SIGNING_PRIVATE_KEY: "${SIGNING_PRIVATE_KEY}"
      DB_HOST: postgres
      DB_NAME: trustvc
      DB_USER: trustvc
      DB_PASSWORD: secret
    ports:
      - "8080:8080"

  webhook-events-2:
    image: ghcr.io/trustvc/webhook-events:latest
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./config.json:/app/config.json:ro
    environment:
      SIGNING_PRIVATE_KEY: "${SIGNING_PRIVATE_KEY}"
      DB_HOST: postgres
      DB_NAME: trustvc
      DB_USER: trustvc
      DB_PASSWORD: secret
    ports:
      - "8081:8080"

volumes:
  pg_data:
```

Both replicas start. Only one acquires the lease per chain and begins polling; the other stands by. If the active replica crashes or its lease expires (after `DB_LEASE_TTL_MS`), the standby steals the lease and resumes from the last persisted block — typically within one `pollIntervalMs` cycle.

### Kubernetes example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trustvc-webhook-events
spec:
  replicas: 2
  selector:
    matchLabels:
      app: trustvc-webhook-events
  template:
    metadata:
      labels:
        app: trustvc-webhook-events
    spec:
      containers:
        - name: webhook-events
          image: ghcr.io/trustvc/webhook-events:latest
          env:
            - name: SIGNING_PRIVATE_KEY
              valueFrom:
                secretKeyRef:
                  name: trustvc-secrets
                  key: signing-private-key
            - name: DB_HOST
              value: postgres-service
            - name: DB_NAME
              value: trustvc
            - name: DB_USER
              value: trustvc
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: trustvc-secrets
                  key: db-password
          volumeMounts:
            - name: config
              mountPath: /app/config.json
              subPath: config.json
      volumes:
        - name: config
          configMap:
            name: trustvc-config
```

### Lease TTL sizing

Set `DB_LEASE_TTL_MS` so a failed replica is detected quickly but not so short that network hiccups trigger false failovers.

| `pollIntervalMs` | Recommended `DB_LEASE_TTL_MS` |
|---|---|
| `3000` (default Stability/Astron) | `15000` (5× poll) |
| `5000` | `25000` |
| `10000` | `45000` |

The lease is renewed at `TTL / 2`. A replica must miss two renewal windows before its lease expires.
