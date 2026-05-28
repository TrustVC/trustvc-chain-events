import pino from 'pino';
import pretty from 'pino-pretty';
import { createSigningKeyManager } from './signing/signing-key.js';
import { loadConfig } from './config/loader.js';
import { createWebhookEmitter } from './delivery/webhook-emitter.js';
import { ChainOrchestrator } from './chain-orchestrator.js';
import { createHealthServer } from './server/health-server.js';
import { isProviderDestroyed } from './rpc/provider-errors.js';
import { meter } from './telemetry/index.js';
import {
  instanceId,
  instanceHealthGauge,
  instanceUptimeGauge,
  instanceActiveChainsGauge,
  instanceActiveWorkersGauge,
  instanceTotalEscrowsGauge,
  chainConnectedGauge,
  chainLastBlockGauge,
  chainEscrowsGauge,
  chainReconnectsGauge,
  trackChainStateChange,
} from './telemetry/metrics.js';
import { openDatabase, closeDatabase } from './db/connection.js';

const signingKey = createSigningKeyManager();
const config = loadConfig();
const log = pino(
  { level: config.logLevel },
  pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'pid,hostname',
    messageFormat: '{msg}',
    levelFirst: true,
  }),
);

log.info({ version: process.env['npm_package_version'] ?? 'unknown' }, 'trustvc-webhook-events starting');

// Log unexpected rejections rather than silently swallowing them.
// Provider-destroyed errors are expected during reconnection and suppressed.
process.on('unhandledRejection', (reason) => {
  if (isProviderDestroyed(reason)) {
    log.debug('Ignored event subscription cancelled during provider teardown');
    return;
  }
  log.error({ reason }, 'Unhandled promise rejection');
});

const emitter = createWebhookEmitter(config.webhook, signingKey, log);
const orchestrator = new ChainOrchestrator(config, emitter, log);
const healthServer = createHealthServer(config.server.port, config.server.host, orchestrator, log);

// ── OTel metrics — instance + per-chain ──────────────────────────────────────

const startedAt = Date.now();
const instanceAttrs = { instance: instanceId };

meter.addBatchObservableCallback(
  (batch) => {
    const statuses = orchestrator.getChainStatuses();
    const degraded = statuses.some((s) => s.providerState.status === 'failed');

    // Instance-level: one series per process replica — enables fleet counting in Grafana.
    batch.observe(instanceUptimeGauge, (Date.now() - startedAt) / 1_000, instanceAttrs);
    batch.observe(instanceHealthGauge, degraded ? 0 : 1, instanceAttrs);
    batch.observe(instanceActiveChainsGauge, orchestrator.chainCount, instanceAttrs);
    batch.observe(instanceActiveWorkersGauge, orchestrator.activeWorkerCount, instanceAttrs);
    batch.observe(instanceTotalEscrowsGauge, orchestrator.totalActiveEscrows, instanceAttrs);

    // Per-chain: one series per chain per replica.
    for (const s of statuses) {
      const attrs = { chain: s.chainKey, transport: s.transport, instance: instanceId };
      batch.observe(chainConnectedGauge, s.providerState.status === 'connected' ? 1 : 0, attrs);
      batch.observe(chainLastBlockGauge, s.providerState.lastSeenBlock ?? 0, attrs);
      batch.observe(chainEscrowsGauge, s.activeEscrows, attrs);
      batch.observe(chainReconnectsGauge, s.providerState.reconnectAttempts, attrs);
      // Emits a counter increment + Tempo span on every status transition.
      trackChainStateChange(s.chainKey, s.transport, s.providerState.status);
    }
  },
  [
    instanceUptimeGauge,
    instanceHealthGauge,
    instanceActiveChainsGauge,
    instanceActiveWorkersGauge,
    instanceTotalEscrowsGauge,
    chainConnectedGauge,
    chainLastBlockGauge,
    chainEscrowsGauge,
    chainReconnectsGauge,
  ],
);

// ── Shutdown ──────────────────────────────────────────────────────────────────

// Hard deadline: if graceful shutdown stalls, force-exit so Docker doesn't wait
// forever before sending SIGKILL. Set slightly below Docker's own stop timeout (30 s).
const SHUTDOWN_TIMEOUT_MS = 28_000;

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Hard-kill timer keeps Docker from waiting past its stop timeout.
  const hardKill = setTimeout(() => {
    log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // unref so this timer alone doesn't keep the event loop alive during a clean shutdown.
  hardKill.unref();

  log.info('Shutdown signal received — stopping chain workers');
  await orchestrator.stopAsync();

  log.info('Chain workers stopped — draining webhook queue');
  await emitter.drain(20_000);

  await healthServer.stop();
  await closeDatabase();
  clearTimeout(hardKill);
  log.info('Shutdown complete');
  process.exit(0);
}

// Register signal handlers before starting so a SIGTERM that arrives during
// startup (e.g. Docker stop while booting) still triggers a graceful shutdown.
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await openDatabase(log);
  await healthServer.start();
  await orchestrator.start();

  const chains = orchestrator.getChainStatuses();
  const chainSummary = chains
    .map((c) => `${c.chainKey} (${c.activeEscrows} escrow${c.activeEscrows !== 1 ? 's' : ''})`)
    .join(', ');

  log.info(
    {
      webhook: config.webhook.url,
      health: `http://${config.server.host}:${config.server.port}/health`,
      chains: chainSummary,
      totalEscrows: orchestrator.totalActiveEscrows,
      workerProcesses: config.server.workerProcesses,
    },
    '✓ Server ready — listening for on-chain events',
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ err: msg }, 'Fatal startup error');
  process.exit(1);
});
