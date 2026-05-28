import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { ChainOrchestrator } from '../chain-orchestrator.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { AppConfig } from '../config/schema.js';
import type { ChainStatus } from '../chain-manager.js';

const VALID_ADDRESS = '0xe6b5ce7E3691a0927b2806CE6638b35237DFfAc4';

// vi.hoisted so these refs are safe to use inside vi.mock factory functions
const h = vi.hoisted(() => ({
  mockDestroy: vi.fn(),
  mockResolveFactory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  return {
    ...actual,
    JsonRpcProvider: vi.fn(() => ({ destroy: h.mockDestroy })),
    WebSocketProvider: vi.fn(() => ({ destroy: h.mockDestroy })),
  };
});

vi.mock('../contracts/factory-resolver.js', () => ({
  resolveFactoryAddress: h.mockResolveFactory,
}));

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockAddRegistry = vi.fn().mockResolvedValue(undefined);
const mockGetStatus = vi.fn().mockReturnValue({
  chainKey: 'ethereum-sepolia',
  chainId: 11155111,
  transport: 'websocket',
  providerState: {
    status: 'connected',
    lastSeenBlock: 100,
    lastConnectedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    reconnectAttempts: 0,
  },
  activeEscrows: 2,
} as ChainStatus);

vi.mock('../chain-manager.js', () => ({
  ChainManager: vi.fn().mockImplementation((_cc, chainDef) => ({
    chainKey: chainDef.key,
    start: mockStart,
    stop: mockStop,
    getStatus: mockGetStatus,
    addRegistry: mockAddRegistry,
  })),
}));

const mockLog: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const mockEmitter: IWebhookEmitter = { emit: vi.fn() };

function makeConfig(chainKeys: string[]): AppConfig {
  return {
    chains: chainKeys.map((chainKey) => ({
      chainKey: chainKey as AppConfig['chains'][0]['chainKey'],
      rpcUrl: 'wss://test.example.com',
      registryAddresses: [VALID_ADDRESS],
      replayBatchSize: 2000,
      replayDelayMs: 0,
      confirmations: 1,
    })),
    webhook: {
      url: 'https://example.com',
      timeoutMs: 10000,
      retryAttempts: 3,
      retryBackoffMs: 1000,
      maxConcurrentDeliveries: 10,
      maxQueueSize: 10_000,
    },
    stateDir: './.state',
    server: { port: 8080, host: '0.0.0.0', workerProcesses: false },
    logLevel: 'info',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockResolvedValue(undefined);
});

describe('ChainOrchestrator', () => {
  it('start() creates a ChainManager for each valid chain config', async () => {
    const { ChainManager } = await import('../chain-manager.js');
    const config = makeConfig(['ethereum-sepolia']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(ChainManager).toHaveBeenCalledTimes(1);
  });

  it('start() skips and logs error for unknown chainKey', async () => {
    const { ChainManager } = await import('../chain-manager.js');
    const config = makeConfig(['ethereum-sepolia']);
    // inject an unknown chain by mutating (type cast)
    (config.chains as unknown as Array<{ chainKey: string }>).push({
      chainKey: 'unknown-chain-xyz',
      ...{
        rpcUrl: 'wss://x.com',
        registryAddresses: [VALID_ADDRESS],
        replayBatchSize: 2000,
        replayDelayMs: 0,
        confirmations: 1,
      },
    } as never);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ chainKey: 'unknown-chain-xyz' }),
      'Unknown chain key — skipping',
    );
    expect(ChainManager).toHaveBeenCalledTimes(1); // only the valid one
  });

  it('start() awaits all managers via Promise.allSettled (parallel)', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it('start() continues when one chain manager fails to start', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    mockStart.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('connect failed'));
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await expect(orchestrator.start()).resolves.not.toThrow();
  });

  it('start() logs error for each rejected manager', async () => {
    const config = makeConfig(['ethereum-sepolia']);
    mockStart.mockRejectedValue(new Error('boot failed'));
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'boot failed' }),
      'Chain failed to start',
    );
  });

  it('stop() calls stop() on all managers', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    orchestrator.stop();
    expect(mockStop).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the managers array (chainCount → 0)', async () => {
    const config = makeConfig(['ethereum-sepolia']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(orchestrator.chainCount).toBe(1);
    orchestrator.stop();
    expect(orchestrator.chainCount).toBe(0);
  });

  it('getChainStatuses() returns array with one status per manager', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    const statuses = orchestrator.getChainStatuses();
    expect(statuses).toHaveLength(2);
  });

  it('totalActiveEscrows sums activeEscrows across all managers', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    mockGetStatus.mockReturnValue({
      chainKey: 'x',
      chainId: 1,
      transport: 'ws',
      providerState: {} as never,
      activeEscrows: 3,
    });
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(orchestrator.totalActiveEscrows).toBe(6); // 3 + 3
  });

  it('chainCount returns correct count', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy', 'polygon']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(orchestrator.chainCount).toBe(3);
  });

  // ── stopAsync ─────────────────────────────────────────────────────────────

  it('stopAsync() stops all in-process managers and clears state', async () => {
    const config = makeConfig(['ethereum-sepolia', 'polygon-amoy']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    expect(orchestrator.chainCount).toBe(2);
    await orchestrator.stopAsync();
    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(orchestrator.chainCount).toBe(0);
  });

  it('stopAsync() resolves when no chains are configured', async () => {
    const config = makeConfig([]);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    await expect(orchestrator.stopAsync()).resolves.toBeUndefined();
  });

  it('stopAsync() is idempotent — second call after chains cleared is a no-op', async () => {
    const config = makeConfig(['ethereum-sepolia']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    await orchestrator.stopAsync();
    await orchestrator.stopAsync(); // second call should not throw
    expect(mockStop).toHaveBeenCalledTimes(1); // only the first call stopped managers
  });

  // ── addRegistry ───────────────────────────────────────────────────────────

  it('addRegistry() delegates to the matching ChainManager', async () => {
    const config = makeConfig(['ethereum-sepolia']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    await orchestrator.addRegistry('ethereum-sepolia', VALID_ADDRESS, 500);
    expect(mockAddRegistry).toHaveBeenCalledWith(VALID_ADDRESS, 500);
  });

  it('addRegistry() logs a warning when no manager exists for the chain', async () => {
    const config = makeConfig(['ethereum-sepolia']);
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.start();
    await orchestrator.addRegistry('polygon-amoy', VALID_ADDRESS, 0);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'polygon-amoy' }),
      'addRegistry: no active manager for chain',
    );
    expect(mockAddRegistry).not.toHaveBeenCalled();
  });
});

// ── verifyRegistry ────────────────────────────────────────────────────────────

describe('ChainOrchestrator.verifyRegistry()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockResolveFactory.mockResolvedValue(undefined);
  });

  it('resolves when address is valid and on-chain check passes', async () => {
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await expect(orchestrator.verifyRegistry('ethereum-sepolia', VALID_ADDRESS)).resolves.toBeUndefined();
    expect(h.mockResolveFactory).toHaveBeenCalledTimes(1);
  });

  it('throws 400 for an invalid EVM address', async () => {
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await expect(orchestrator.verifyRegistry('ethereum-sepolia', 'not-an-address')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid EVM address'),
    });
    expect(h.mockResolveFactory).not.toHaveBeenCalled();
  });

  it('throws 400 when chainKey is not in config', async () => {
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await expect(orchestrator.verifyRegistry('polygon-amoy', VALID_ADDRESS)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('not in your config'),
    });
  });

  it('throws 422 when resolveFactoryAddress fails', async () => {
    h.mockResolveFactory.mockRejectedValueOnce(new Error('not a registry contract'));
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await expect(orchestrator.verifyRegistry('ethereum-sepolia', VALID_ADDRESS)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('not a valid TrustVC registry'),
    });
  });

  it('calls provider.destroy() even when resolveFactoryAddress throws', async () => {
    h.mockResolveFactory.mockRejectedValueOnce(new Error('rpc error'));
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await orchestrator.verifyRegistry('ethereum-sepolia', VALID_ADDRESS).catch(() => {});
    expect(h.mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('uses WebSocketProvider for wss:// rpcUrl', async () => {
    const { WebSocketProvider, JsonRpcProvider } = await import('ethers');
    const orchestrator = new ChainOrchestrator(makeConfig(['ethereum-sepolia']), mockEmitter, mockLog);
    await orchestrator.verifyRegistry('ethereum-sepolia', VALID_ADDRESS);
    expect(WebSocketProvider).toHaveBeenCalledWith('wss://test.example.com');
    expect(JsonRpcProvider).not.toHaveBeenCalled();
  });

  it('uses JsonRpcProvider for https:// rpcUrl', async () => {
    const { WebSocketProvider, JsonRpcProvider } = await import('ethers');
    const config = makeConfig(['ethereum-sepolia']);
    config.chains[0].rpcUrl = 'https://test.example.com';
    const orchestrator = new ChainOrchestrator(config, mockEmitter, mockLog);
    await orchestrator.verifyRegistry('ethereum-sepolia', VALID_ADDRESS);
    expect(JsonRpcProvider).toHaveBeenCalledWith('https://test.example.com');
    expect(WebSocketProvider).not.toHaveBeenCalled();
  });
});
