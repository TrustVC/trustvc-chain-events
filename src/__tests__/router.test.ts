import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mock controllers before any module under test is imported ─────────────────

const m = vi.hoisted(() => ({
  handleHealth: vi.fn(),
  handlePostRegistry: vi.fn().mockResolvedValue(undefined),
  handleGetRegistries: vi.fn().mockResolvedValue(undefined),
  handleDeleteRegistry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../server/controllers/health.js', () => ({ handleHealth: m.handleHealth }));
vi.mock('../server/controllers/registry.js', () => ({
  handlePostRegistry: m.handlePostRegistry,
  handleGetRegistries: m.handleGetRegistries,
  handleDeleteRegistry: m.handleDeleteRegistry,
}));

import { createRouter } from '../server/router.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function makeRes() {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

const mockOrchestrator = {} as never;
const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createRouter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /health dispatches to handleHealth', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const res = makeRes();
    await dispatch(makeReq('GET', '/health'), res);
    expect(m.handleHealth).toHaveBeenCalledWith(res, mockOrchestrator);
  });

  it('POST /registry dispatches to handlePostRegistry', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const req = makeReq('POST', '/registry');
    const res = makeRes();
    await dispatch(req, res);
    expect(m.handlePostRegistry).toHaveBeenCalledWith(req, res, mockOrchestrator, mockLog);
  });

  it('GET /registries dispatches to handleGetRegistries', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const res = makeRes();
    await dispatch(makeReq('GET', '/registries'), res);
    expect(m.handleGetRegistries).toHaveBeenCalledWith(res, mockOrchestrator);
  });

  it('DELETE /registry/ethereum-sepolia/0xabc dispatches to handleDeleteRegistry', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const req = makeReq('DELETE', '/registry/ethereum-sepolia/0xabc');
    const res = makeRes();
    await dispatch(req, res);
    expect(m.handleDeleteRegistry).toHaveBeenCalledWith(req, res);
  });

  it('DELETE /registry/ prefix (any sub-path) dispatches to handleDeleteRegistry', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    await dispatch(makeReq('DELETE', '/registry/polygon-amoy/0xDEF'), makeRes());
    expect(m.handleDeleteRegistry).toHaveBeenCalledTimes(1);
  });

  it('GET /unknown returns 404', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const res = makeRes();
    await dispatch(makeReq('GET', '/unknown'), res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });

  it('PUT /health (wrong method) returns 404', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const res = makeRes();
    await dispatch(makeReq('PUT', '/health'), res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(m.handleHealth).not.toHaveBeenCalled();
  });

  it('GET /registry (not DELETE) returns 404', async () => {
    const dispatch = createRouter(mockOrchestrator, mockLog);
    const res = makeRes();
    await dispatch(makeReq('GET', '/registry/ethereum/0xabc'), res);
    expect(res.writeHead).toHaveBeenCalledWith(404);
  });
});
