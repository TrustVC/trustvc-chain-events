/**
 * Per-chain child process worker.
 *
 * Lifecycle:
 *  1. Parent forks this file and immediately sends { type: 'init', ... }
 *  2. Worker starts ChainManager with a ForwardingEmitter that IPC-sends CloudEvents to parent
 *  3. Worker sends { type: 'ready' } when manager.start() resolves
 *  4. Worker sends { type: 'status', ... } heartbeat every 5 s
 *  5. On { type: 'stop' } from parent, worker calls manager.stop() and exits cleanly
 */

import pino from 'pino';
import pretty from 'pino-pretty';
import { ChainManager } from '../chain-manager.js';
import { CHAIN_CATALOG_BY_KEY } from '../chains/catalog.js';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import type { DeliveryResult, IWebhookEmitter } from '../interfaces/emitter.js';
import type { IpcChildMessage, IpcParentMessage } from '../interfaces/ipc.js';
import { openDatabase, closeDatabase } from '../db/connection.js';

function send(msg: IpcChildMessage): void {
  process.send?.(msg);
}

// Forwarding emitter: instead of POSTing to the webhook, send the event to the
// parent process via IPC. The parent holds the real WebhookEmitter + queue.
const forwardingEmitter: IWebhookEmitter = {
  async emit(event: CloudEvent): Promise<DeliveryResult> {
    send({ type: 'event', payload: event });
    return { success: true, attempts: 0, durationMs: 0 };
  },
};

// Wait for the init message, then start the chain manager.
process.once('message', async (raw: unknown) => {
  const msg = raw as IpcParentMessage;
  if (msg.type !== 'init') {
    send({ type: 'error', message: `Expected init message, got: ${msg.type}` });
    process.exit(1);
  }

  const { chainConfig, chainDefKey, logLevel, stateDir } = msg;

  const chainDef = CHAIN_CATALOG_BY_KEY.get(chainDefKey);
  if (!chainDef) {
    send({ type: 'error', message: `Unknown chain key: ${chainDefKey}` });
    process.exit(1);
  }

  const log = pino(
    { level: logLevel },
    pretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
      messageFormat: '{msg}',
      levelFirst: true,
    }),
  );
  const manager = new ChainManager(chainConfig, chainDef, forwardingEmitter, log, stateDir);

  // Status heartbeat — parent uses this to serve /health and /metrics
  const heartbeat = setInterval(() => {
    send({ type: 'status', status: manager.getStatus() });
  }, 5_000);
  heartbeat.unref();

  let stopping = false;
  function stopWorker(): void {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    manager.stop();
    void closeDatabase().finally(() => process.exit(0));
  }

  // Handle stop signal from parent process (normal shutdown path).
  process.on('message', (raw2: unknown) => {
    const m = raw2 as IpcParentMessage;
    if (m.type === 'stop') stopWorker();
    else if (m.type === 'addRegistry') {
      void manager
        .addRegistry(m.address, m.fromBlock)
        .then(() => {
          send({ type: 'registryAdded', address: m.address });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err: msg, address: m.address }, 'addRegistry failed in worker');
        });
    } else if (m.type === 'removeRegistry') {
      manager.removeRegistry(m.address);
      send({ type: 'registryRemoved', address: m.address });
    }
  });

  // Handle OS signals directly (e.g. docker stop sends SIGTERM; Ctrl+C sends SIGINT).
  process.on('SIGTERM', stopWorker);
  process.on('SIGINT', stopWorker);
  // open db instance in each worker
  await openDatabase(log);

  try {
    await manager.start();
    send({ type: 'ready', status: manager.getStatus() });
    // Send an immediate status after ready so parent has accurate initial state
    send({ type: 'status', status: manager.getStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', message });
    await closeDatabase();
    process.exit(1);
  }
});
