# TrustVC Chain Events

Self-hosted sidecar that streams TrustVC ETR on-chain events to your system as signed [CloudEvents 1.0](https://cloudevents.io/) webhooks. Every lifecycle change on any ETR token — mint, transfer, surrender, burn — arrives at your endpoint within seconds of chain finality.

- **Source and full docs:** [github.com/TrustVC/trustvc-chain-events](https://github.com/TrustVC/trustvc-chain-events)
- **Releases and changelog:** [GitHub Releases](https://github.com/TrustVC/trustvc-chain-events/releases)
- **Also published to:** `ghcr.io/trustvc/trustvc-chain-events`

---

## Security notice — Node2Shell (CVE-2026-111497)

Images built on Node.js earlier than **22.23.4** are affected by Node2Shell, a high-severity flaw in the Brotli decoder bundled with Node.js. This service sends events with `fetch()`, which decompresses Brotli responses automatically, so a malicious or compromised webhook endpoint could exploit it.

Images from this release onward use `node:22.23.4-alpine`. **Pull the latest tag and redeploy.** If you build from source, rebuild with `docker compose build --pull`.

Check the runtime version of a running container:

```bash
docker exec <container> node --version   # must print v22.23.4 or later
```

---

## Supported tags

| Tag | Meaning |
|---|---|
| `vX.Y.Z` (e.g. `v0.0.5`) | An exact release. Recommended for production. |
| `latest` | The most recent release. |

Every image is built for `linux/amd64` and `linux/arm64` on `node:22.23.4-alpine`. See [Releases](https://github.com/TrustVC/trustvc-chain-events/releases) for what changed in each tag.

---

## Quick start

### 1. Generate a signing key (one-time)

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

Give `public.pem` to the system that receives the webhooks. Keep `private.pem` secret.

### 2. Create `config.json`

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

`${ENV_VAR}` placeholders are filled from the container environment at startup, so keep secrets out of the file. A fuller example is in [config.example.json](https://github.com/TrustVC/trustvc-chain-events/blob/main/config.example.json).

### 3. Run

Nothing is baked into the image: mount `config.json` and pass secrets as environment variables.

```bash
docker run -d \
  --name trustvc-chain-events \
  -v $(pwd)/config.json:/app/config.json:ro \
  -e SIGNING_PRIVATE_KEY="$(cat private.pem)" \
  -e ALCHEMY_API_KEY=your-key \
  -p 8080:8080 \
  --restart unless-stopped \
  trustvc/trustvc-chain-events:latest
```

Or with Docker Compose:

```yaml
services:
  trustvc-chain-events:
    image: trustvc/trustvc-chain-events:latest
    ports:
      - "8080:8080"
    volumes:
      - ./config.json:/app/config.json:ro
    env_file:
      - .env
    restart: unless-stopped
```

Confirm it is running:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SIGNING_PRIVATE_KEY` | **Yes** | Ed25519 private key — PEM or base64 32-byte seed |
| `CONFIG_PATH` | No | Path to the config file inside the container (default: `/app/config.json`) |
| `DB_HOST` | No | Database host — enables persistence, the Registry API and HA leasing |
| `DB_DIALECT` | No | `postgres` (default), `mysql`, `mariadb` or `mssql` |
| `DB_PORT` | No | Database port (default: `5432` for PostgreSQL) |
| `DB_NAME` | No | Database name (default: `trustvc_events`) |
| `DB_USER` | No | Database username (default: `trustvc`) |
| `DB_PASSWORD` | No | Database password |
| `OTEL_ENABLED` | No | Set to `true` to enable OpenTelemetry traces and metrics |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP collector endpoint (default: `http://localhost:4318`) |

The full list, including pool and lease tuning, is in the [README](https://github.com/TrustVC/trustvc-chain-events#environment-variables).

## Ports and volumes

| | Value | Notes |
|---|---|---|
| Port | `8080` | `/health` and the Registry API |
| Volume | `/app/config.json` | Mount read-only |

## Supported chains

`ethereum`, `ethereum-sepolia`, `polygon`, `polygon-amoy`, `xdc`, `xdc-apothem`, `stability`, `stability-testnet`, `astron`, `astron-testnet`. See [Supported Chains](https://github.com/TrustVC/trustvc-chain-events#supported-chains) for transport and expected delivery lag.

---

## Webhook delivery

Each event is an HTTP `POST` with a CloudEvents 1.0 JSON body and an `X-TrustVC-Signature: ed25519=<base64url-signature>` header. Verify it with your public key:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';

const publicKey = crypto.createPublicKey(fs.readFileSync('public.pem'));

function verifyTrustVCWebhook(rawBody: Buffer, signatureHeader: string): boolean {
  const signature = Buffer.from(signatureHeader.replace('ed25519=', ''), 'base64url');
  return crypto.verify(null, rawBody, publicKey, signature);
}
```

Use `data.transactionHash + data.logIndex` as the idempotency key. The payload format and all event types are listed in the [README](https://github.com/TrustVC/trustvc-chain-events#webhook-payload).

---

## Upgrading

```bash
docker pull trustvc/trustvc-chain-events:latest
docker compose up -d        # or: docker rm -f <container> && docker run ... (same flags)
```

Check [Releases](https://github.com/TrustVC/trustvc-chain-events/releases) before upgrading. Releases that need action from operators say so at the top of their notes.

## Further reading

| Topic | Guide |
|---|---|
| Horizontal scaling and high availability | [auto-scaling.md](https://github.com/TrustVC/trustvc-chain-events/blob/main/docs/auto-scaling.md) |
| Avoiding RPC rate limits | [rate-limits.md](https://github.com/TrustVC/trustvc-chain-events/blob/main/docs/rate-limits.md) |
| Database setup and persistence | [database.md](https://github.com/TrustVC/trustvc-chain-events/blob/main/docs/database.md) |
| Telemetry and Grafana dashboards | [telemetry.md](https://github.com/TrustVC/trustvc-chain-events/blob/main/docs/telemetry.md) |

## License

[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
