# Auto Scaling and High Availability

By default the sidecar is designed as a **single-replica** service — one container per deployment is the recommended starting point. When you need fault tolerance or zero-downtime across availability zones, PostgreSQL-backed distributed leasing is built in.

> **⚠️ Important — Scaling and HA require a database**
>
> Running more than one replica **requires PostgreSQL** (`DB_HOST` must be set). Without it, every replica polls the chain independently and your webhook endpoint receives **duplicate events** — one copy per replica, for every on-chain action.
>
> The database solves this in two ways:
> - **One replica owns each chain at a time** — replicas compete for a lease stored in `chain_leases`. Only the winner polls; the others wait on standby.
> - **Progress survives restarts** — the last processed block is persisted in `block_progress`, so a restarting replica picks up exactly where it left off instead of replaying from scratch.
>
> Without a database you can only run a **single replica** safely.

---

## How It Works

Three database tables coordinate multiple replicas:

| Table | Purpose |
|---|---|
| `chain_leases` | Atomic lease — only one replica polls each chain at a time |
| `block_progress` | Last-seen block cursor — on restart, replay only the delta |
| `escrows` | Known TitleEscrow addresses — skips full rescan on startup |

When two replicas start for the same chain, only one acquires the lease and begins polling. The other waits. If the active replica crashes or its lease expires (after `DB_LEASE_TTL_MS`), the standby steals the lease and resumes from the last persisted block — typically within one `pollIntervalMs` cycle.

---

## Requirements

Set `DB_HOST` in your environment. No changes to `config.json` are needed. See the [database setup guide](database.md) for the full list of variables.

---

## Docker Compose — Two Replicas

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

A ready-made compose file for this setup is at [`docker-compose.ha.yml`](../docker-compose.ha.yml).

---

## Kubernetes — Deployment

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
          ports:
            - containerPort: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
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

---

## Lease TTL Sizing

Set `DB_LEASE_TTL_MS` so a failed replica is detected quickly without false failovers from network hiccups. The lease is renewed at `TTL / 2`, so a replica must miss two renewal windows before its lease expires.

| `pollIntervalMs` | Recommended `DB_LEASE_TTL_MS` |
|---|---|
| `3000` (Stability / Astron default) | `15000` |
| `5000` | `25000` |
| `10000` | `45000` |

For WebSocket chains there is no `pollIntervalMs`. A `DB_LEASE_TTL_MS` of `30000` (the default) is appropriate.

---

## Worker Processes

Each chain runs in its own forked child process by default (`workerProcesses: true`). The parent process holds the single `WebhookEmitter` and delivery queue. If a child crashes, it restarts automatically after 5 seconds without affecting other chains.

Set `workerProcesses: false` to run all chains in a single process — useful for debugging or low-resource environments.
