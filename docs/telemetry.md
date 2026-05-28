# Telemetry — Metrics and Traces

Telemetry is **off by default** — the service runs with zero-overhead no-op stubs unless you opt in. When enabled, metrics and traces are exported via [OpenTelemetry](https://opentelemetry.io/) OTLP and work with any compatible collector.

---

## Enabling Telemetry

Set these environment variables:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://<your-collector>:4318
OTEL_SERVICE_NAME=trustvc-webhook-events     # default — change if you run multiple deployments
OTEL_INSTANCE_ID=replica-1                   # optional — defaults to hostname-pid
```

`OTEL_EXPORTER_OTLP_ENDPOINT` accepts any OTLP HTTP endpoint:

| Collector | Endpoint |
|---|---|
| Grafana Alloy (local) | `http://alloy:4318` |
| OpenTelemetry Collector | `http://otel-collector:4318` |
| Grafana Cloud | `https://otlp-gateway-<region>.grafana.net/otlp` |
| Datadog | `http://datadog-agent:4318` |
| Honeycomb | `https://api.honeycomb.io` |

---

## Metrics Exported

### Instance-level metrics

One series per replica, labeled `instance=<OTEL_INSTANCE_ID>`.

| Metric | Description |
|---|---|
| `trustvc_instance_health` | `1` = healthy, `0` = degraded |
| `trustvc_instance_uptime_seconds` | Process uptime — gaps indicate restarts |
| `trustvc_instance_active_chains` | Chains currently running on this replica |
| `trustvc_instance_active_workers` | Forked child processes |
| `trustvc_instance_total_escrows` | Total TitleEscrow subscriptions across all chains |

### Per-chain metrics

Labeled `chain`, `transport`, and `instance`.

| Metric | Description |
|---|---|
| `trustvc_chain_connected` | `1` = RPC connected, `0` = disconnected |
| `trustvc_chain_last_seen_block` | Latest block processed |
| `trustvc_chain_active_escrows` | Active TitleEscrow subscriptions |
| `trustvc_chain_reconnect_attempts` | Cumulative reconnection count |
| `trustvc_chain_state_changes_total` | Increments on every status transition, labeled `from_status` / `to_status` |

---

## Traces

Every chain status transition emits a short trace span (`chain.status_changed`) visible in Tempo, Jaeger, or any trace backend. Spans include `chain`, `from_status`, `to_status`, and `instance` attributes.

---

## Grafana Dashboard

A ready-to-import dashboard JSON is at [`telemetry/sample/grafana-dashboard.json`](../telemetry/sample/grafana-dashboard.json).

**To import:** Grafana → Dashboards → Import → Upload JSON. Set the Prometheus data source to your Mimir or Prometheus instance.

The dashboard includes:

- Fleet overview stat cards — active instances, healthy vs degraded, total chains, total escrows
- Per-instance status table and uptime trend
- Chain connection status timeline and reconnect attempts
- State-transition rate chart and cumulative transition table
- Active escrows and last-seen block per chain

---

## Example: Grafana Cloud

Add to your `.env`:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp
OTEL_SERVICE_NAME=trustvc-webhook-events
```

Pass your Grafana Cloud credentials as an HTTP header via the OTLP exporter. The standard way is to set the authorization header in your collector config and proxy through Grafana Alloy — the sidecar itself only needs `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## Example: Local Stack (Grafana Alloy + Mimir + Tempo)

```yaml
# docker-compose additions
  alloy:
    image: grafana/alloy:latest
    volumes:
      - ./alloy-config.river:/etc/alloy/config.river
    ports:
      - "4318:4318"    # OTLP HTTP

  webhook-events:
    environment:
      OTEL_ENABLED: "true"
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy:4318"
```

The Alloy config can fan out to both Mimir (metrics) and Tempo (traces) from the single OTLP intake.
