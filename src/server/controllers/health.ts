import type { ServerResponse } from 'node:http';
import type { ChainOrchestrator } from '../../chain-orchestrator.js';
import { sendJson } from '../utils/request.js';

export function handleHealth(res: ServerResponse, orchestrator: ChainOrchestrator): void {
  const statuses = orchestrator.getChainStatuses();
  const degraded = statuses.some((s) => s.providerState.status === 'failed');
  const allConnected = statuses.every((s) => s.providerState.status === 'connected');
  const status = degraded ? 'degraded' : allConnected ? 'ok' : 'starting';
  sendJson(res, degraded ? 503 : 200, { status });
}
