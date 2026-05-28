import { createServer } from 'node:http';
import type { Logger } from 'pino';
import type { ChainOrchestrator } from '../chain-orchestrator.js';
import { createRouter } from './router.js';

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHealthServer(
  port: number,
  host: string,
  orchestrator: ChainOrchestrator,
  log: Logger,
): HealthServer {
  const dispatch = createRouter(orchestrator, log);
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          log.info({ port, host }, 'Health server listening');
          resolve();
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
