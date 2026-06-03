# @trustvc/trustvc-chain-events

Self-hosted Docker sidecar that streams TrustVC ETR on-chain events to your system as signed [CloudEvents 1.0](https://cloudevents.io/) webhooks. Every lifecycle change on any ETR token — mint, transfer, surrender, burn — arrives at your endpoint within seconds of chain finality.

---

## Why Self-Hosted

| Concern | Self-hosted sidecar |
|---|---|
| Data sovereignty | Events never leave your network |
| Provider flexibility | Use your own Alchemy/QuickNode account |
| Compliance | Runs in a private VPC — no outbound except to your RPC and webhook |
| Isolation | Each deployment is independent; no multi-tenancy |
| No TrustVC dependency | Your availability is decoupled from TrustVC infrastructure |

---

## Quick Start

### Step 1 — Generate a signing key (one-time)

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

Or use a base64-encoded 32-byte seed:

```bash
openssl rand -base64 32   # paste as SIGNING_PRIVATE_KEY
```

### Step 2 — Configure

```bash
cp config.example.json config.json
# Edit config.json — set your RPC URL and webhook URL
# Registry addresses can be left empty and added later via the API
```

Create a `.env` file:

```bash
cp .env.example .env
# Set SIGNING_PRIVATE_KEY to the PEM contents or base64 seed
```

Minimal `config.json`:

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

### Step 3 — Run

#### Using the published Docker image (recommended)

> **Recommended:** pull from Docker Hub

```bash
docker pull trustvc/trustvc-chain-events:latest
```

> Also available on GitHub Container Registry (GHCR):

```bash
docker pull ghcr.io/trustvc/trustvc-chain-events:latest
```

Two things are supplied at runtime — nothing is baked into the image:

| What | How |
|---|---|
| `config.json` (chains, RPC URLs, webhook) | Volume mount |
| Secrets (`SIGNING_PRIVATE_KEY`, DB creds, etc.) | `.env` file or `-e` flags |

**Option A — env file (simplest)**

```bash
docker run -d \
  -v $(pwd)/config.json:/app/config.json:ro \
  --env-file .env \
  -p 8080:8080 \
  trustvc/trustvc-chain-events:latest
```

**Option B — inline flags**

```bash
docker run -d \
  -v $(pwd)/config.json:/app/config.json:ro \
  -e SIGNING_PRIVATE_KEY="$(cat private.pem)" \
  -e DB_HOST=your-postgres-host \
  -e DB_PASSWORD=secret \
  -p 8080:8080 \
  trustvc/trustvc-chain-events:latest
```

**Option C — Docker Compose**

```yaml
services:
  webhook-events:
    image: trustvc/trustvc-chain-events:latest
    ports:
      - "8080:8080"
    volumes:
      - ./config.json:/app/config.json:ro
    env_file:
      - .env
    restart: unless-stopped
```

```bash
docker compose up -d
```

#### Building from source

```bash
npm run docker:prod   # build and run via Docker Compose
npm install && npm run dev   # local Node.js watch mode
```

Confirm it is running:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## Configuration Reference

Mount a `config.json` or point `CONFIG_PATH` at your file. `${ENV_VAR}` placeholders are interpolated from the process environment at startup — keep secrets out of the file.

### Chain fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `chainKey` | **Yes** | — | See [Supported Chains](#supported-chains) |
| `rpcUrl` | **Yes** | — | `wss://`, `ws://`, `https://`, or `http://` |
| `registryAddresses` | No | `[]` | EVM addresses of your Token Registries; can be added later via [API](#registry-api) |
| `replayFromBlock` | No | `0` | Block where your registry was deployed |
| `replayBatchSize` | No | `2000` | Max blocks per `eth_getLogs` call — lower this on free-tier RPCs |
| `replayDelayMs` | No | `0` | Delay between replay batches — add `500`–`1000` ms on free-tier RPCs |
| `confirmations` | No | `1` | Blocks to wait before delivery (max `12`) |
| `pollIntervalMs` | No | chain default | HTTP-polling chains only (`stability`, `astron`); omit for WebSocket chains |

### Webhook fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `url` | **Yes** | — | Your downstream endpoint |
| `timeoutMs` | No | `10000` | Per-attempt timeout in ms |
| `retryAttempts` | No | `3` | Retries on failure (max `10`) |
| `retryBackoffMs` | No | `1000` | Base backoff — doubles each attempt |
| `headers` | No | none | Extra headers on every delivery (e.g. `X-Api-Key`) |
| `maxConcurrentDeliveries` | No | `10` | Max parallel in-flight POSTs |
| `maxQueueSize` | No | `10000` | In-memory event buffer — extras are logged and dropped |

### Server fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `port` | No | `8080` | Health check bind port |
| `host` | No | `0.0.0.0` | Keep `0.0.0.0` in Docker |
| `workerProcesses` | No | `true` | Spawn each chain in its own process for fault isolation |
| `logLevel` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

---

## Supported Chains

| `chainKey` | Network | Transport | Approx. delivery lag |
|---|---|---|---|
| `ethereum` | Ethereum Mainnet | WebSocket | ~13 min |
| `ethereum-sepolia` | Ethereum Sepolia | WebSocket | ~13 min |
| `polygon` | Polygon Mainnet | WebSocket | ~4 min |
| `polygon-amoy` | Polygon Amoy | WebSocket | ~4 min |
| `xdc` | XDC Network | WebSocket | ~4 sec |
| `xdc-apothem` | XDC Apothem | WebSocket | ~4 sec |
| `stability` | Stability Mainnet | HTTP polling | ~3 sec |
| `stability-testnet` | Stability Testnet | HTTP polling | ~3 sec |
| `astron` | Astron Mainnet | HTTP polling | ~3 sec |
| `astron-testnet` | Astron Testnet | HTTP polling | ~3 sec |

Delivery lag is a property of each chain's consensus and cannot be shortened without accepting reorg risk.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SIGNING_PRIVATE_KEY` | **Yes** | Ed25519 private key — PEM or base64 32-byte seed |
| `CONFIG_PATH` | No | Path to config file (default: `./config.json`) |
| `DB_HOST` | No | PostgreSQL host — enables persistence and HA leasing |
| `DB_PORT` | No | PostgreSQL port (default: `5432`) |
| `DB_NAME` | No | Database name (default: `trustvc`) |
| `DB_USER` | No | Database username (default: `postgres`) |
| `DB_PASSWORD` | No | Database password |
| `DB_POOL_MAX` | No | Connection pool max (default: `5`) |
| `DB_LEASE_TTL_MS` | No | Distributed lease TTL in ms (default: `30000`) |
| `OTEL_ENABLED` | No | Set to `true` to enable OpenTelemetry traces and metrics |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP collector endpoint (default: `http://localhost:4318`) |
| `OTEL_SERVICE_NAME` | No | Service name in telemetry (default: `trustvc-webhook-events`) |

---

## Webhook Payload

Every event is delivered as an HTTP `POST`:

```
Content-Type: application/json
X-TrustVC-Signature: ed25519=<base64url-signature>
```

Body follows CloudEvents 1.0:

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

**Idempotency key:** use `data.transactionHash + data.logIndex`.

### Event Types

| `type` | Trigger |
|---|---|
| `com.trustvc.etr.minted` | Token minted |
| `com.trustvc.etr.burned` | Token burned |
| `com.trustvc.etr.surrendered` | Token surrendered to registry |
| `com.trustvc.etr.restored` | Token restored from registry |
| `com.trustvc.etr.registry_paused` | Registry paused |
| `com.trustvc.etr.registry_unpaused` | Registry unpaused |
| `com.trustvc.etr.escrow_created` | New TitleEscrow deployed |
| `com.trustvc.etr.token_received` | Escrow took custody |
| `com.trustvc.etr.nomination` | Beneficiary nominee set |
| `com.trustvc.etr.beneficiary_transfer` | Beneficiary transferred |
| `com.trustvc.etr.holder_transfer` | Holder transferred |
| `com.trustvc.etr.return_to_issuer` | Token returned to issuer |
| `com.trustvc.etr.shred` | Token permanently destroyed |
| `com.trustvc.etr.reject_transfer_beneficiary` | Beneficiary transfer rejected |
| `com.trustvc.etr.reject_transfer_holder` | Holder transfer rejected |
| `com.trustvc.etr.reject_transfer_owners` | Both roles rejected simultaneously |

---

## Signature Verification

Every request is signed with an **Ed25519** key. Your receiver holds only the public key — it cannot forge payloads even if compromised.

### Node.js

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';

const publicKey = crypto.createPublicKey(fs.readFileSync('public.pem'));

function verifyTrustVCWebhook(rawBody: Buffer, signatureHeader: string): boolean {
  const signature = Buffer.from(signatureHeader.replace('ed25519=', ''), 'base64url');
  return crypto.verify(null, rawBody, publicKey, signature);
}
```

## Registry API

> [!WARNING]
> **Requires a database.** Set `DB_HOST` to enable this API. All endpoints return `503` when no database is configured.

### POST /registry — add a registry at runtime

```bash
curl -X POST http://localhost:8080/registry \
  -H 'Content-Type: application/json' \
  -d '{"chainKey":"ethereum-sepolia","address":"0xYourRegistryAddress","fromBlock":6000000}'
```

| Field | Required | Description |
|---|---|---|
| `chainKey` | Yes | Must match a key in your running config |
| `address` | Yes | EVM address of the Token Registry |
| `fromBlock` | No | Block to replay from (default: `0`) |

| HTTP | Meaning |
|---|---|
| `200` | Registry added and syncing |
| `400` | Missing/invalid fields |
| `422` | Address is not a deployed TrustVC registry on that chain |
| `503` | DB not configured |

### GET /registries — list all registries

```bash
curl http://localhost:8080/registries
```

### DELETE /registry/:chainKey/:address — remove a registry

```bash
curl -X DELETE http://localhost:8080/registry/ethereum-sepolia/0xabc...
```

### GET /health

```bash
curl http://localhost:8080/health
```

| `status` | Meaning | HTTP |
|---|---|---|
| `ok` | All chains connected | 200 |
| `starting` | At least one chain still connecting | 200 |
| `degraded` | At least one chain permanently failed | 503 |

---

## Advanced Topics

| Topic | Guide |
|---|---|
| Horizontal scaling and high availability | [docs/auto-scaling.md](docs/auto-scaling.md) |
| Avoiding RPC rate limits | [docs/rate-limits.md](docs/rate-limits.md) |
| Database setup and persistence | [docs/database.md](docs/database.md) |
| Telemetry and Grafana dashboards | [docs/telemetry.md](docs/telemetry.md) |

---

## Local Development

```bash
npm install

npm run dev           # TypeScript watch mode
npm run docker:dev    # Docker hot-reload (bind-mounts src/)
npm run docker:prod   # Docker production build

npm run build         # compile TypeScript → dist/
npm test              # unit tests (Vitest)
npm run check         # ESLint + Prettier + tsc --noEmit
npm run fix           # auto-fix lint and format issues
```

---

## License

Copyright 2024 TrustVC — [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)
