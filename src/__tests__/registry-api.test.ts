import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { createHealthServer } from '../server/health-server.js';
import type { ChainOrchestrator } from '../chain-orchestrator.js';
import type { ProviderState } from '../rpc/provider-state.js';

// ── DB mocks ──────────────────────────────────────────────────────────────────

const m = vi.hoisted(() => ({
  getDb: vi.fn().mockReturnValue(null),
  saveRegistry: vi.fn().mockResolvedValue(undefined),
  loadRegistries: vi.fn().mockResolvedValue([]),
  removeRegistry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db/connection.js', () => ({ getDb: m.getDb }));
vi.mock('../db/repositories/registry-repo.js', () => ({
  saveRegistry: m.saveRegistry,
  loadRegistries: m.loadRegistries,
  removeRegistry: m.removeRegistry,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function doFetch(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const VALID_ADDRESS = '0xe6b5ce7E3691a0927b2806CE6638b35237DFfAc4';

function makeOrchestrator(overrides: Partial<ChainOrchestrator> = {}): ChainOrchestrator {
  return {
    getChainStatuses: () => [
      {
        chainKey: 'ethereum-sepolia',
        chainId: 11155111,
        transport: 'websocket' as const,
        providerState: { status: 'connected' } as ProviderState,
        activeEscrows: 0,
      },
    ],
    verifyRegistry: vi.fn().mockResolvedValue(undefined),
    addRegistry: vi.fn().mockResolvedValue(undefined),
    removeRegistry: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ChainOrchestrator;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /registry', () => {
  let port: number;
  let server: Awaited<ReturnType<typeof createHealthServer>>;

  beforeEach(async () => {
    port = await freePort();
    vi.clearAllMocks();
    m.getDb.mockReturnValue(null);
    m.saveRegistry.mockResolvedValue(undefined);
    m.loadRegistries.mockResolvedValue([]);
    m.removeRegistry.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('returns 400 when chainKey is missing', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', { address: VALID_ADDRESS });
    expect(r.status).toBe(400);
  });

  it('returns 400 when address is missing', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia' });
    expect(r.status).toBe(400);
  });

  it('returns 400 for an unrecognised chainKey', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', { chainKey: 'unknown-chain-xyz', address: VALID_ADDRESS });
    expect(r.status).toBe(400);
    expect((r.json as Record<string, unknown>)['error']).toMatch(/Unknown chainKey/);
  });

  it('returns 422 when verifyRegistry signals 422', async () => {
    const err = Object.assign(new Error('not a registry'), { statusCode: 422 });
    const orchestrator = makeOrchestrator({ verifyRegistry: vi.fn().mockRejectedValue(err) });
    server = createHealthServer(port, '127.0.0.1', orchestrator, mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS });
    expect(r.status).toBe(422);
  });

  it('returns 400 when verifyRegistry signals 400', async () => {
    const err = Object.assign(new Error('invalid address'), { statusCode: 400 });
    const orchestrator = makeOrchestrator({ verifyRegistry: vi.fn().mockRejectedValue(err) });
    server = createHealthServer(port, '127.0.0.1', orchestrator, mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS });
    expect(r.status).toBe(400);
  });

  it('returns 200 and calls addRegistry on success (no DB)', async () => {
    const orchestrator = makeOrchestrator();
    server = createHealthServer(port, '127.0.0.1', orchestrator, mockLog as never);
    await server.start();
    const r = await doFetch(port, 'POST', '/registry', {
      chainKey: 'ethereum-sepolia',
      address: VALID_ADDRESS,
      fromBlock: 100,
    });
    expect(r.status).toBe(200);
    expect(orchestrator.addRegistry).toHaveBeenCalledWith('ethereum-sepolia', VALID_ADDRESS.toLowerCase(), 100);
  });

  it('defaults fromBlock to 0 when omitted', async () => {
    const orchestrator = makeOrchestrator();
    server = createHealthServer(port, '127.0.0.1', orchestrator, mockLog as never);
    await server.start();
    await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS });
    expect(orchestrator.addRegistry).toHaveBeenCalledWith('ethereum-sepolia', VALID_ADDRESS.toLowerCase(), 0);
  });

  it('lowercases the address before storing and forwarding', async () => {
    const orchestrator = makeOrchestrator();
    server = createHealthServer(port, '127.0.0.1', orchestrator, mockLog as never);
    await server.start();
    await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS.toUpperCase() });
    expect(orchestrator.addRegistry).toHaveBeenCalledWith(
      'ethereum-sepolia',
      VALID_ADDRESS.toLowerCase(),
      expect.any(Number),
    );
  });

  it('persists to DB when DB is available', async () => {
    m.getDb.mockReturnValue({} as never);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS });
    expect(m.saveRegistry).toHaveBeenCalledWith('ethereum-sepolia', VALID_ADDRESS.toLowerCase(), 0);
  });

  it('does NOT persist to DB when DB is unavailable', async () => {
    m.getDb.mockReturnValue(null);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    await doFetch(port, 'POST', '/registry', { chainKey: 'ethereum-sepolia', address: VALID_ADDRESS });
    expect(m.saveRegistry).not.toHaveBeenCalled();
  });
});

describe('GET /registries', () => {
  let port: number;
  let server: Awaited<ReturnType<typeof createHealthServer>>;

  beforeEach(async () => {
    port = await freePort();
    vi.clearAllMocks();
    m.getDb.mockReturnValue(null);
    m.loadRegistries.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('returns 503 when DB is not configured', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'GET', '/registries');
    expect(r.status).toBe(503);
  });

  it('returns 200 with per-chain registry lists when DB is available', async () => {
    m.getDb.mockReturnValue({} as never);
    m.loadRegistries.mockResolvedValue([{ address: '0xabc', fromBlock: 50 }]);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'GET', '/registries');
    expect(r.status).toBe(200);
    expect((r.json as Record<string, unknown>)['ethereum-sepolia']).toEqual([{ address: '0xabc', fromBlock: 50 }]);
  });

  it('calls loadRegistries for each chain reported by the orchestrator', async () => {
    m.getDb.mockReturnValue({} as never);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    await doFetch(port, 'GET', '/registries');
    expect(m.loadRegistries).toHaveBeenCalledWith('ethereum-sepolia');
  });
});

describe('DELETE /registry/:chainKey/:address', () => {
  let port: number;
  let server: Awaited<ReturnType<typeof createHealthServer>>;

  beforeEach(async () => {
    port = await freePort();
    vi.clearAllMocks();
    m.getDb.mockReturnValue(null);
    m.removeRegistry.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('returns 503 when DB is not configured', async () => {
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'DELETE', `/registry/ethereum-sepolia/${VALID_ADDRESS}`);
    expect(r.status).toBe(503);
  });

  it('returns 200 and calls removeRegistry when DB is available', async () => {
    m.getDb.mockReturnValue({} as never);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'DELETE', `/registry/ethereum-sepolia/${VALID_ADDRESS}`);
    expect(r.status).toBe(200);
    expect(m.removeRegistry).toHaveBeenCalledWith('ethereum-sepolia', VALID_ADDRESS.toLowerCase());
  });

  it('lowercases the address in the response body', async () => {
    m.getDb.mockReturnValue({} as never);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'DELETE', `/registry/ethereum-sepolia/${VALID_ADDRESS.toUpperCase()}`);
    expect((r.json as Record<string, unknown>)['address']).toBe(VALID_ADDRESS.toLowerCase());
  });

  it('response body contains active: false', async () => {
    m.getDb.mockReturnValue({} as never);
    server = createHealthServer(port, '127.0.0.1', makeOrchestrator(), mockLog as never);
    await server.start();
    const r = await doFetch(port, 'DELETE', `/registry/ethereum-sepolia/${VALID_ADDRESS}`);
    expect((r.json as Record<string, unknown>)['active']).toBe(false);
  });
});
