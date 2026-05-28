/**
 * Centralised OTel metric definitions and state-change tracking.
 *
 * All metric objects are singletons — import what you need and call
 * meter.addBatchObservableCallback() in src/index.ts to populate them.
 *
 * Prometheus name mapping (dots → underscores):
 *   trustvc.instance.health           → trustvc_instance_health
 *   trustvc.instance.uptime_seconds   → trustvc_instance_uptime_seconds
 *   trustvc.instance.active_chains    → trustvc_instance_active_chains
 *   trustvc.instance.active_workers   → trustvc_instance_active_workers
 *   trustvc.instance.total_escrows    → trustvc_instance_total_escrows
 *   trustvc.chain.connected           → trustvc_chain_connected
 *   trustvc.chain.last_seen_block     → trustvc_chain_last_seen_block
 *   trustvc.chain.active_escrows      → trustvc_chain_active_escrows
 *   trustvc.chain.reconnect_attempts  → trustvc_chain_reconnect_attempts
 *   trustvc.chain.state_changes       → trustvc_chain_state_changes_total
 */

import { hostname } from 'node:os';
import { meter, tracer } from './index.js';

// Stable identity for this process — used as the `instance` metric label so
// Grafana can distinguish replicas even when running on the same host.
export const instanceId = process.env['OTEL_INSTANCE_ID'] ?? `${hostname()}-${process.pid}`;

// ── Instance-level gauges ─────────────────────────────────────────────────────

export const instanceHealthGauge = meter.createObservableGauge('trustvc.instance.health', {
  description: '1 = ok / starting, 0 = degraded (at least one chain permanently failed)',
});

export const instanceUptimeGauge = meter.createObservableGauge('trustvc.instance.uptime_seconds', {
  description: 'Process uptime in seconds',
  unit: 's',
});

export const instanceActiveChainsGauge = meter.createObservableGauge('trustvc.instance.active_chains', {
  description: 'Number of chains currently running on this process instance',
});

export const instanceActiveWorkersGauge = meter.createObservableGauge('trustvc.instance.active_workers', {
  description: 'Active child worker processes (0 when workerProcesses=false)',
});

export const instanceTotalEscrowsGauge = meter.createObservableGauge('trustvc.instance.total_escrows', {
  description: 'Total active TitleEscrow subscriptions across all chains on this instance',
});

// ── Per-chain gauges ──────────────────────────────────────────────────────────

export const chainConnectedGauge = meter.createObservableGauge('trustvc.chain.connected', {
  description: '1 = RPC connected, 0 = not connected',
});

export const chainLastBlockGauge = meter.createObservableGauge('trustvc.chain.last_seen_block', {
  description: 'Latest block number observed per chain',
});

export const chainEscrowsGauge = meter.createObservableGauge('trustvc.chain.active_escrows', {
  description: 'Active TitleEscrow subscriptions per chain',
});

export const chainReconnectsGauge = meter.createObservableGauge('trustvc.chain.reconnect_attempts', {
  description: 'Cumulative RPC reconnection attempts per chain',
});

// ── State-change counter ──────────────────────────────────────────────────────

export const chainStateChangesCounter = meter.createCounter('trustvc.chain.state_changes', {
  description: 'Cumulative count of chain RPC provider state transitions',
});

// ── State-change tracker ──────────────────────────────────────────────────────

const prevStates = new Map<string, string>();

/**
 * Call once per metrics tick per chain. Increments the state-changes counter
 * and emits a short OTel span (visible in Tempo) only when the status changes.
 */
export function trackChainStateChange(chainKey: string, transport: string, newStatus: string): void {
  const prev = prevStates.get(chainKey);
  if (prev === newStatus) return;
  prevStates.set(chainKey, newStatus);
  if (prev === undefined) return; // first observation — no transition to record

  const attrs = { chain: chainKey, transport, from_status: prev, to_status: newStatus, instance: instanceId };
  chainStateChangesCounter.add(1, attrs);

  // Short span so the transition is visible as a mark in Tempo's trace view.
  const span = tracer.startSpan('chain.status_changed', { attributes: attrs });
  span.addEvent('state_transition', attrs);
  span.end();
}
