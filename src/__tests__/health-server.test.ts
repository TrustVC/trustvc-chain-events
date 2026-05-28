import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { createHealthServer } from '../server/health-server.js';
import type { ChainOrchestrator } from '../chain-orchestrator.js';
import type { ProviderState } from '../rpc/provider-state.js';

// ---- Helpers ----

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

function makeProviderState(status: ProviderState['status']): ProviderState {
  return {
    status,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastError: null,
    reconnectAttempts: 0,
    lastSeenBlock: null,
  };
}

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeOrchestrator(statuses: Array<{ chainKey: string; status: ProviderState['status'] }>): ChainOrchestrator {
  return {
    getChainStatuses: () =>
      statuses.map(({ chainKey, status }) => ({
        chainKey,
        chainId: 1,
        transport: 'websocket',
        providerState: makeProviderState(status),
        activeEscrows: 0,
      })),
  } as unknown as ChainOrchestrator;
}

// ---- Tests ----

describe('createHealthServer', () => {
  let port: number;
  let server: Awaited<ReturnType<typeof createHealthServer>>;

  beforeEach(async () => {
    port = await freePort();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('GET /health returns 200 with status ok when all chains connected', async () => {
    server = createHealthServer(
      port,
      '127.0.0.1',
      makeOrchestrator([{ chainKey: 'ethereum', status: 'connected' }]),
      mockLog as never,
    );
    await server.start();
    const { status, body } = await get(port, '/health');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('ok');
  });

  it('GET /health returns 200 with status starting when some chain is connecting', async () => {
    server = createHealthServer(
      port,
      '127.0.0.1',
      makeOrchestrator([{ chainKey: 'ethereum', status: 'connecting' }]),
      mockLog as never,
    );
    await server.start();
    const { status, body } = await get(port, '/health');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('starting');
  });

  it('GET /health returns 503 with status degraded when any chain is failed', async () => {
    server = createHealthServer(
      port,
      '127.0.0.1',
      makeOrchestrator([{ chainKey: 'ethereum', status: 'failed' }]),
      mockLog as never,
    );
    await server.start();
    const { status, body } = await get(port, '/health');
    expect(status).toBe(503);
    expect(JSON.parse(body).status).toBe('degraded');
  });

  it('GET /health body contains only status field', async () => {
    server = createHealthServer(
      port,
      '127.0.0.1',
      makeOrchestrator([{ chainKey: 'ethereum', status: 'connected' }]),
      mockLog as never,
    );
    await server.start();
    const { body } = await get(port, '/health');
    expect(Object.keys(JSON.parse(body))).toEqual(['status']);
  });

  it('GET /unknown-path returns 404', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator([]), mockLog as never);
    await server.start();
    const { status } = await get(port, '/not-found');
    expect(status).toBe(404);
  });

  it('server starts and stop() closes gracefully', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator([]), mockLog as never);
    await expect(server.start()).resolves.not.toThrow();
    await expect(server.stop()).resolves.not.toThrow();
    server = undefined as never;
  });
});
