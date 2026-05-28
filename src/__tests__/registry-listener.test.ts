import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Provider } from 'ethers';
import type { Logger } from 'pino';
import { RegistryListener } from '../listeners/registry-listener.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import { normalizeRegistryTransfer, normalizeRegistryPause } from '../delivery/event-normalizer.js';

const m = vi.hoisted(() => ({
  contractOn: vi.fn(),
  contractRemoveAllListeners: vi.fn(),
  waitForTransaction: vi.fn().mockResolvedValue({}),
}));

vi.mock('ethers', () => ({
  Contract: vi.fn(() => ({
    on: m.contractOn,
    removeAllListeners: m.contractRemoveAllListeners,
  })),
}));

// Mock normalizers without referencing module-level variables (TDZ-safe)
vi.mock('../delivery/event-normalizer.js', () => ({
  normalizeRegistryTransfer: vi.fn(),
  normalizeRegistryPause: vi.fn(),
}));

const ZERO = '0x0000000000000000000000000000000000000000';
const BURN = '0x000000000000000000000000000000000000dEaD';
const REGISTRY = '0xAbCd1234AbCd1234AbCd1234AbCd1234AbCd1234';
const HOLDER = '0x1111111111111111111111111111111111111111';

function makeCloudEvent(type: string): CloudEvent {
  return {
    specversion: '1.0',
    id: 'id',
    source: 'src',
    type,
    datacontenttype: 'application/json',
    time: '',
    subject: '1',
    data: {
      chainKey: 'ethereum',
      chainId: 1,
      registryAddress: REGISTRY.toLowerCase(),
      tokenId: '1',
      blockNumber: 1,
      transactionHash: '0xtx',
      logIndex: 0,
      payload: {},
      idempotencyKey: '1-0xtx-0',
    },
  };
}

const mockLog: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const mockEmitter: IWebhookEmitter = {
  emit: vi.fn().mockResolvedValue({ success: true, attempts: 1, durationMs: 1 }),
};
const mockProvider = { waitForTransaction: m.waitForTransaction } as unknown as Provider;

function makeListener(confirmations = 1): RegistryListener {
  return new RegistryListener(REGISTRY, 'ethereum', 1, mockProvider, mockEmitter, mockLog, confirmations);
}

function makeEvLog(extra = {}) {
  return { blockNumber: 1, transactionHash: '0xtx', index: 0, address: REGISTRY, ...extra };
}

function makePayload(eventName: string, evLog = makeEvLog()) {
  return { fragment: { name: eventName }, log: evLog, args: { toObject: () => ({}) } };
}

function getHandler() {
  const call = m.contractOn.mock.calls.find(([ev]) => ev === '*');
  if (!call) throw new Error('wildcard listener not registered');
  return call[1] as (...args: unknown[]) => void;
}

async function flush(n = 4) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const mockTransfer = normalizeRegistryTransfer as ReturnType<typeof vi.fn>;
const mockPause = normalizeRegistryPause as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.waitForTransaction.mockResolvedValue({});
  mockTransfer.mockReturnValue(makeCloudEvent('com.trustvc.etr.minted'));
  mockPause.mockReturnValue(makeCloudEvent('com.trustvc.etr.registry_paused'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RegistryListener', () => {
  it('emits etr.minted when Transfer from=0x0 (confirmations=1)', async () => {
    mockTransfer.mockReturnValue(makeCloudEvent('com.trustvc.etr.minted'));
    const listener = makeListener(1);
    listener.start();
    getHandler()(ZERO, HOLDER, 1n, makePayload('Transfer'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'com.trustvc.etr.minted' }));
  });

  it('emits etr.burned when Transfer to=0xdEaD', async () => {
    mockTransfer.mockReturnValue(makeCloudEvent('com.trustvc.etr.burned'));
    const listener = makeListener(1);
    listener.start();
    getHandler()(HOLDER, BURN, 1n, makePayload('Transfer'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'com.trustvc.etr.burned' }));
  });

  it('emits etr.surrendered when Transfer to=registryAddress', async () => {
    mockTransfer.mockReturnValue(makeCloudEvent('com.trustvc.etr.surrendered'));
    const listener = makeListener(1);
    listener.start();
    getHandler()(HOLDER, REGISTRY, 1n, makePayload('Transfer'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'com.trustvc.etr.surrendered' }));
  });

  it('emits etr.restored when Transfer from=registryAddress', async () => {
    mockTransfer.mockReturnValue(makeCloudEvent('com.trustvc.etr.restored'));
    const listener = makeListener(1);
    listener.start();
    getHandler()(REGISTRY, HOLDER, 1n, makePayload('Transfer'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'com.trustvc.etr.restored' }));
  });

  it('does NOT emit when normalizeRegistryTransfer returns null', async () => {
    mockTransfer.mockReturnValue(null);
    const listener = makeListener(1);
    listener.start();
    getHandler()(HOLDER, HOLDER, 1n, makePayload('Transfer'));
    await flush();
    expect(mockEmitter.emit).not.toHaveBeenCalled();
  });

  it('waits for confirmations before emitting when confirmations=2', async () => {
    const listener = makeListener(2);
    listener.start();
    getHandler()(ZERO, HOLDER, 1n, makePayload('Transfer'));
    await flush(6);
    expect(m.waitForTransaction).toHaveBeenCalledWith('0xtx', 2);
  });

  it('emits etr.registry_paused on PauseWithRemark', async () => {
    mockPause.mockReturnValue(makeCloudEvent('com.trustvc.etr.registry_paused'));
    const listener = makeListener(1);
    listener.start();
    getHandler()('maintenance', makePayload('PauseWithRemark'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'com.trustvc.etr.registry_paused' }));
  });

  it('emits etr.registry_unpaused on UnpauseWithRemark', async () => {
    mockPause.mockReturnValue(makeCloudEvent('com.trustvc.etr.registry_unpaused'));
    const listener = makeListener(1);
    listener.start();
    getHandler()('', makePayload('UnpauseWithRemark'));
    await flush();
    expect(mockEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'com.trustvc.etr.registry_unpaused' }),
    );
  });

  it('logs error and continues if emitter.emit throws', async () => {
    (mockEmitter.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('emit failed'));
    const listener = makeListener(1);
    listener.start();
    getHandler()(ZERO, HOLDER, 1n, makePayload('Transfer'));
    await flush(6);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('stop() removes all listeners', () => {
    const listener = makeListener(1);
    listener.start();
    listener.stop();
    expect(m.contractRemoveAllListeners).toHaveBeenCalledTimes(1);
  });
});
