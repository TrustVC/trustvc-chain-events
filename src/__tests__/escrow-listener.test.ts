import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Provider } from 'ethers';
import type { Logger } from 'pino';
import { EscrowListener } from '../listeners/escrow-listener.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';

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

vi.mock('../delivery/event-normalizer.js', () => ({
  normalizeEscrowEvent: vi.fn().mockReturnValue({
    specversion: '1.0',
    id: 'ev-id',
    source: 'src',
    type: 'com.trustvc.etr.holder_transfer',
    datacontenttype: 'application/json',
    time: new Date().toISOString(),
    subject: '1',
    data: {
      chainKey: 'ethereum',
      chainId: 1,
      registryAddress: '0xreg',
      tokenId: '1',
      blockNumber: 1,
      transactionHash: '0xtx',
      logIndex: 0,
      payload: {},
    },
  }),
}));

const mockLog: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const mockEmitter: IWebhookEmitter = {
  emit: vi.fn().mockResolvedValue({ success: true, attempts: 1, durationMs: 1 }),
};

const mockProvider = {
  waitForTransaction: m.waitForTransaction,
} as unknown as Provider;

function makeEscrowListener(confirmations = 1, onShred?: () => void): EscrowListener {
  return new EscrowListener(
    '0xescrow',
    '0xregistry',
    1n,
    'ethereum',
    1,
    mockProvider,
    mockEmitter,
    mockLog,
    confirmations,
    onShred,
  );
}

// Build a fake evLog argument that the listener callback receives as last arg
function makeEvLog(args?: Record<string, unknown>) {
  return {
    blockNumber: 100,
    transactionHash: '0xtx',
    index: 0,
    address: '0xescrow',
    args: args ? { toObject: () => args } : undefined,
  };
}

function makePayload(eventName: string, log = makeEvLog()) {
  return { fragment: { name: eventName }, log, args: log.args ?? { toObject: () => ({}) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.waitForTransaction.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EscrowListener', () => {
  it('attaches one wildcard listener on start() (single eth_subscribe)', () => {
    const listener = makeEscrowListener();
    listener.start();
    expect(m.contractOn).toHaveBeenCalledTimes(1);
    expect(m.contractOn).toHaveBeenCalledWith('*', expect.any(Function));
  });

  it('emits webhook immediately when confirmations=1', async () => {
    const listener = makeEscrowListener(1);
    listener.start();
    // Grab the callback registered for the first event
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer'));
    // give the fire-and-forget IIFE a chance to run
    await Promise.resolve();
    await Promise.resolve();
    expect(m.waitForTransaction).not.toHaveBeenCalled();
    expect(mockEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('calls waitForTransaction when confirmations=2', async () => {
    const listener = makeEscrowListener(2);
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.waitForTransaction).toHaveBeenCalledWith('0xtx', 2, 120_000);
  });

  it('does not emit when normalizeEscrowEvent returns null', async () => {
    const { normalizeEscrowEvent } = await import('../delivery/event-normalizer.js');
    (normalizeEscrowEvent as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const listener = makeEscrowListener();
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer'));
    await Promise.resolve();
    expect(mockEmitter.emit).not.toHaveBeenCalled();
  });

  it('converts bigint args to strings in namedArgs', async () => {
    const { normalizeEscrowEvent } = await import('../delivery/event-normalizer.js');
    const listener = makeEscrowListener();
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer', makeEvLog({ amount: 1000n, owner: '0xabc' })));
    await Promise.resolve();
    await Promise.resolve();
    const argsPassedToNormalizer = (normalizeEscrowEvent as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(argsPassedToNormalizer.amount).toBe('1000');
    expect(argsPassedToNormalizer.owner).toBe('0xabc');
  });

  it('passes correct tokenId and registryAddress to normalizer', async () => {
    const { normalizeEscrowEvent } = await import('../delivery/event-normalizer.js');
    const listener = new EscrowListener(
      '0xescrow',
      '0xMyRegistry',
      42n,
      'ethereum',
      1,
      mockProvider,
      mockEmitter,
      mockLog,
    );
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer'));
    await Promise.resolve();
    await Promise.resolve();
    const call = (normalizeEscrowEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBe(42n); // tokenId
    expect(call[3]).toBe('0xMyRegistry'); // registryAddress
  });

  it('logs error and continues if emitter.emit throws', async () => {
    (mockEmitter.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('emit failed'));
    const listener = makeEscrowListener();
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('HolderTransfer'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('stop() removes all listeners from contract', () => {
    const listener = makeEscrowListener();
    listener.start();
    listener.stop();
    expect(m.contractRemoveAllListeners).toHaveBeenCalledTimes(1);
  });

  // ── Shred / onShred callback ───────────────────────────────────────────────

  it('calls onShred callback after a Shred event is emitted', async () => {
    const onShred = vi.fn();
    const listener = makeEscrowListener(1, onShred);
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('Shred'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onShred).toHaveBeenCalledTimes(1);
  });

  it('does not call onShred for non-Shred events', async () => {
    const onShred = vi.fn();
    const listener = makeEscrowListener(1, onShred);
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    for (const name of ['HolderTransfer', 'BeneficiaryTransfer', 'TokenReceived', 'Nomination']) {
      await cb(makePayload(name));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(onShred).not.toHaveBeenCalled();
  });

  it('calls stop() automatically on Shred (removes all contract listeners)', async () => {
    const listener = makeEscrowListener(1);
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('Shred'));
    await Promise.resolve();
    await Promise.resolve();
    // The automatic stop() triggered by Shred should call removeAllListeners
    expect(m.contractRemoveAllListeners).toHaveBeenCalledTimes(1);
  });

  it('still emits the Shred webhook event before calling onShred', async () => {
    const callOrder: string[] = [];
    (mockEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('emit');
      return { success: true, attempts: 1, durationMs: 1 };
    });
    const onShred = vi.fn(() => {
      callOrder.push('onShred');
    });
    const listener = makeEscrowListener(1, onShred);
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    await cb(makePayload('Shred'));
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(['emit', 'onShred']);
  });

  it('works correctly when no onShred callback is provided (no error thrown)', async () => {
    const listener = makeEscrowListener(1); // no onShred
    listener.start();
    const [, cb] = m.contractOn.mock.calls[0];
    // cb is void — just call it and assert the Shred event was emitted normally
    cb(makePayload('Shred'));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockEmitter.emit).toHaveBeenCalledTimes(1);
  });
});
