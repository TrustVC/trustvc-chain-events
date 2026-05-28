import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { ChainOrchestrator } from '../chain-orchestrator.js';
import { handleHealth } from './controllers/health.js';
import { handlePostRegistry, handleGetRegistries, handleDeleteRegistry } from './controllers/registry.js';

export function createRouter(
  orchestrator: ChainOrchestrator,
  log: Logger,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    if (method === 'GET' && url === '/health') {
      handleHealth(res, orchestrator);
    } else if (method === 'POST' && url === '/registry') {
      await handlePostRegistry(req, res, orchestrator, log);
    } else if (method === 'GET' && url === '/registries') {
      await handleGetRegistries(res, orchestrator);
    } else if (method === 'DELETE' && url?.startsWith('/registry/')) {
      await handleDeleteRegistry(req, res, orchestrator);
    } else {
      res.writeHead(404);
      res.end();
    }
  };
}
