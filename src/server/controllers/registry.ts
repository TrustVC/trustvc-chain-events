import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { ChainOrchestrator } from '../../chain-orchestrator.js';
import { getDb } from '../../db/connection.js';
import { loadRegistries, saveRegistry, removeRegistry } from '../../db/repositories/registry-repo.js';
import { CHAIN_CATALOG_BY_KEY } from '../../chains/catalog.js';
import { readBody, sendJson } from '../utils/request.js';

export async function handlePostRegistry(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: ChainOrchestrator,
  log: Logger,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const chainKey = typeof body['chainKey'] === 'string' ? body['chainKey'] : null;
    const address = typeof body['address'] === 'string' ? body['address'].toLowerCase() : null;
    const fromBlock = typeof body['fromBlock'] === 'number' ? body['fromBlock'] : 0;

    if (!chainKey || !address) {
      sendJson(res, 400, { error: 'chainKey and address are required' });
      return;
    }
    if (!CHAIN_CATALOG_BY_KEY.has(chainKey)) {
      sendJson(res, 400, { error: `Unknown chainKey: ${chainKey}` });
      return;
    }

    try {
      await orchestrator.verifyRegistry(chainKey, address);
    } catch (verifyErr) {
      const code = (verifyErr as { statusCode?: number }).statusCode ?? 422;
      const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      sendJson(res, code, { error: msg });
      return;
    }

    if (getDb()) await saveRegistry(chainKey, address, fromBlock);
    await orchestrator.addRegistry(chainKey, address, fromBlock);
    sendJson(res, 200, { chainKey, address, fromBlock });
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'POST /registry failed');
    sendJson(res, code, { error: msg });
  }
}

export async function handleGetRegistries(res: ServerResponse, orchestrator: ChainOrchestrator): Promise<void> {
  if (!getDb()) {
    sendJson(res, 503, { error: 'DB not configured — registry API unavailable' });
    return;
  }
  const statuses = orchestrator.getChainStatuses();
  const result: Record<string, { address: string; fromBlock: number }[]> = {};
  for (const s of statuses) {
    result[s.chainKey] = await loadRegistries(s.chainKey);
  }
  sendJson(res, 200, result);
}

export async function handleDeleteRegistry(
  req: IncomingMessage,
  res: ServerResponse,
  orchestrator: ChainOrchestrator,
): Promise<void> {
  const pathname = req.url!.split('?')[0]!;
  const parts = pathname.split('/');
  const chainKey = parts[2];
  const address = parts[3]?.toLowerCase();

  if (!chainKey || !address) {
    sendJson(res, 400, { error: 'chainKey and address are required' });
    return;
  }
  if (!getDb()) {
    sendJson(res, 503, { error: 'DB not configured — registry API unavailable' });
    return;
  }
  await removeRegistry(chainKey, address);
  await orchestrator.removeRegistry(chainKey, address);
  sendJson(res, 200, { chainKey, address, active: false });
}
