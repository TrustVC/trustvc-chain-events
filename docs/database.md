# Database Setup and Persistence

The database is **optional**. Without it the sidecar runs fine as a single-replica, stateless service — replay restarts from `replayFromBlock` on every boot.

When you set `DB_HOST`, three features are unlocked:

| Feature | What it does |
|---|---|
| **Block cursor** | Persists the last-seen replay block — restarts resume where they left off |
| **Escrow cache** | Persists discovered TitleEscrow addresses — eliminates full rescan on restart |
| **Distributed leasing** | Coordinates multiple replicas — only one polls each chain at a time |
| **Runtime registry API** | Allows adding and removing registry addresses without restarting |

---

## Supported Database

PostgreSQL 14 or later. The schema is managed automatically by Sequelize — no manual migration step is needed.

---

## Environment Variables

Set these alongside `SIGNING_PRIVATE_KEY` in your `.env` or container environment.

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | *(unset)* | PostgreSQL hostname. Setting this enables all DB features. |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `trustvc` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | *(empty)* | Database password |
| `DB_POOL_MAX` | `5` | Max connections in the pool |
| `DB_POOL_MIN` | `1` | Min connections in the pool |
| `DB_LEASE_TTL_MS` | `30000` | Distributed lease TTL in ms — set to at least 3× `pollIntervalMs` |

If `DB_HOST` is not set, the service starts normally with no database dependency. All DB features are silently skipped.

---

## Quick Setup with Docker Compose

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

  webhook-events:
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

volumes:
  pg_data:
```

The service syncs the schema on first boot. No `CREATE TABLE` commands are needed.

---

## What Gets Stored

### `block_progress`

Stores the last block number successfully processed per chain. Used to resume replay after a restart without re-scanning from `replayFromBlock`.

### `escrows`

Stores discovered TitleEscrow contract addresses and their associated registry and token ID. On startup these are loaded into memory so the service can re-subscribe to existing escrows instantly — no historical replay needed for already-known escrows.

### `chain_leases`

Distributed lock table. Each replica periodically renews its lease for each chain it is actively polling. If a lease expires, another replica acquires it and takes over. See [auto-scaling.md](auto-scaling.md) for TTL sizing guidance.

### `registry_addresses`

Stores registry addresses added via the [Registry API](../README.md#registry-api). On startup these are loaded alongside any addresses in `config.json`, so dynamically added registries survive restarts.

---

## Runtime Registry API

With a database configured you can add and remove Token Registry addresses at runtime without editing `config.json` or restarting the container.

```bash
# Add a registry — starts syncing immediately
curl -X POST http://localhost:8080/registry \
  -H 'Content-Type: application/json' \
  -d '{"chainKey":"ethereum-sepolia","address":"0xYourRegistry","fromBlock":6000000}'

# List all registered addresses
curl http://localhost:8080/registries

# Remove a registry
curl -X DELETE http://localhost:8080/registry/ethereum-sepolia/0xYourRegistry
```

Without `DB_HOST` these endpoints return `503 Service Unavailable`.

---

## Without a Database

The service works fine without any database:

- Replay restarts from `replayFromBlock` on every boot
- Escrow subscriptions are rebuilt from scratch via log replay on every boot
- Only one replica should run (no lease coordination)
- Registry addresses must be set in `config.json`

For a low-traffic, single-chain deployment this is perfectly adequate.
