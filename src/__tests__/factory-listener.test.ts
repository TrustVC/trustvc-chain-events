import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Provider } from 'ethers';
import type { Logger } from 'pino';
import { Contract } from 'ethers';
import { FactoryListener } from '../listeners/factory-listener.js';
import { isRateLimit } from '../rpc/provider-errors.js';
import { EscrowListener } from '../listeners/escrow-listener.js';
import { isEventLog } from '../contracts/event-log.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';

// ---- Module mocks ----
vi.mock('ethers', () => ({
  Contract: vi.fn(),
  Interface: vi.fn(() => ({
    parseLog: vi.fn().mockReturnValue(null),
  })),
}));
vi.mock('../listeners/escrow-listener.js', () => ({
  EscrowListener: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../contracts/event-log.js', () => ({
  isEventLog: vi.fn().mockReturnValue(true),
}));

// ---- Per-test mutable state ----
let contractInstance: {
  filters: Record<string, unknown>;
  queryFilter: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
};
let mockGetBlockNumber: ReturnType<typeof vi.fn>;

const REGISTRY = '0xregistry000000000000000000000000000000';
const watchedRegistries = new Set([REGISTRY]);

const mockLog: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const mockEmitter: IWebhookEmitter = {
  emit: vi.fn().mockResolvedValue({ success: true, attempts: 1, durationMs: 1 }),
};

function makeListener(
  overrides: {
    replayFromBlock?: number;
    replayBatchSize?: number;
    replayDelayMs?: number;
    confirmations?: number;
  } = {},
): FactoryListener {
  return new FactoryListener(
    '0xfactory',
    watchedRegistries,
    'ethereum-sepolia',
    11155111,
    { getBlockNumber: mockGetBlockNumber } as unknown as Provider,
    mockEmitter,
    mockLog,
    overrides.replayFromBlock ?? 0,
    overrides.replayBatchSize ?? 10_000,
    overrides.replayDelayMs ?? 0,
    overrides.confirmations ?? 1,
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  contractInstance = {
    filters: { TitleEscrowCreated: vi.fn().mockReturnValue({}) },
    queryFilter: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  (Contract as ReturnType<typeof vi.fn>).mockReturnValue(contractInstance);

  mockGetBlockNumber = vi.fn().mockResolvedValue(1000);

  // Restore per-test defaults after clearAllMocks
  (isEventLog as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (EscrowListener as ReturnType<typeof vi.fn>).mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- isRateLimit ----
describe('isRateLimit', () => {
  it('returns true when err.error.code === 429', () => {
    expect(isRateLimit({ error: { code: 429 } })).toBe(true);
  });

  it('returns true when err.code === 429', () => {
    expect(isRateLimit({ code: 429 })).toBe(true);
  });

  it('returns true when message includes "429"', () => {
    expect(isRateLimit(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('returns true when message includes "compute units"', () => {
    expect(isRateLimit(new Error('exceeded compute units limit'))).toBe(true);
  });

  it('returns false for non-rate-limit error', () => {
    expect(isRateLimit(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRateLimit(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRateLimit(undefined)).toBe(false);
  });

  it('returns false for Error with unrelated message', () => {
    expect(isRateLimit(new Error('timeout exceeded'))).toBe(false);
  });

  it('returns true for numeric code 429 on error object', () => {
    expect(isRateLimit({ code: 429, message: 'rate limited' })).toBe(true);
  });
});

// ---- queryFilterWithRetry (via start → replayHistoricalEscrows) ----
describe('queryFilterWithRetry behaviour via start()', () => {
  it('returns logs on first success', async () => {
    contractInstance.queryFilter.mockResolvedValue([]);
    await makeListener().start();
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on 2nd attempt', async () => {
    vi.useFakeTimers();
    const err429 = Object.assign(new Error('rate limit'), { code: 429 });
    contractInstance.queryFilter.mockRejectedValueOnce(err429).mockResolvedValue([]);
    const p = makeListener().start();
    await vi.runAllTimersAsync();
    await p;
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries (6) on repeated 429', async () => {
    vi.useFakeTimers();
    const err429 = Object.assign(new Error('429'), { code: 429 });
    for (let i = 0; i < 6; i++) contractInstance.queryFilter.mockRejectedValueOnce(err429);
    contractInstance.queryFilter.mockResolvedValue([]);
    const p = makeListener().start();
    await vi.runAllTimersAsync();
    await p;
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(7);
  });

  it('returns null and logs error after all retries exhausted (429)', async () => {
    vi.useFakeTimers();
    const err429 = Object.assign(new Error('429'), { code: 429 });
    contractInstance.queryFilter.mockRejectedValue(err429);
    const p = makeListener().start();
    await vi.runAllTimersAsync();
    await p;
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('does not retry on non-429 error', async () => {
    contractInstance.queryFilter.mockRejectedValue(new Error('internal error'));
    await makeListener().start();
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(1);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('backoff delay is applied before retry (fake timers)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const err429 = Object.assign(new Error('429'), { code: 429 });
    contractInstance.queryFilter.mockRejectedValueOnce(err429).mockResolvedValue([]);
    const p = makeListener().start();
    // Advance past the first retry backoff (~1000ms for attempt 0)
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.runAllTimersAsync();
    await p;
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(2);
  });

  it('jitter is applied to backoff (Math.random called)', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random');
    const err429 = Object.assign(new Error('429'), { code: 429 });
    contractInstance.queryFilter.mockRejectedValueOnce(err429).mockResolvedValue([]);
    const p = makeListener().start();
    await vi.runAllTimersAsync();
    await p;
    expect(randomSpy).toHaveBeenCalled();
  });

  it('backoff is capped at 32000ms after many retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const err429 = Object.assign(new Error('429'), { code: 429 });
    for (let i = 0; i < 6; i++) contractInstance.queryFilter.mockRejectedValueOnce(err429);
    contractInstance.queryFilter.mockResolvedValue([]);
    const p = makeListener().start();
    await vi.runAllTimersAsync();
    await p;
    expect(contractInstance.queryFilter.mock.calls.length).toBeGreaterThan(1);
  });
});

// ---- replayHistoricalEscrows ----
describe('replayHistoricalEscrows (via start())', () => {
  it('returns early with warning if TitleEscrowCreated filter not found', async () => {
    contractInstance.filters = {}; // remove TitleEscrowCreated
    await makeListener().start();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ethereum-sepolia' }),
      expect.stringContaining('TitleEscrowCreated filter not found'),
    );
  });

  it('returns early with error if getBlockNumber() fails', async () => {
    mockGetBlockNumber.mockRejectedValue(new Error('network error'));
    await makeListener().start();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ethereum-sepolia' }),
      'Could not fetch block number — skipping replay',
    );
  });

  it('skips eth_getLogs when replayFrom is ahead of chain head', async () => {
    mockGetBlockNumber.mockResolvedValue(100);
    await makeListener({ replayFromBlock: 200 }).start();
    expect(contractInstance.queryFilter).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ethereum-sepolia' }),
      'Escrow sync skipped — already caught up',
    );
  });

  it('logs sync start, progress, and completion', async () => {
    mockGetBlockNumber.mockResolvedValue(999);
    contractInstance.queryFilter.mockResolvedValue([]);
    await makeListener({ replayBatchSize: 1000 }).start();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ethereum-sepolia' }),
      expect.stringContaining('Starting escrow sync'),
    );
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'ethereum-sepolia' }),
      expect.stringContaining('Escrow sync complete'),
    );
  });

  it('attaches EscrowListener for discovered escrows in watched registries', async () => {
    const mockEvLog = { args: ['0xescrowaddr', REGISTRY, 1000n] };
    contractInstance.queryFilter.mockResolvedValue([mockEvLog]);
    await makeListener().start();
    expect(EscrowListener).toHaveBeenCalled();
  });

  it('skips escrows whose registry is not in watchedRegistries', async () => {
    const mockEvLog = { args: ['0xescrowaddr', '0xother_registry_not_watched', 1000n] };
    contractInstance.queryFilter.mockResolvedValue([mockEvLog]);
    await makeListener().start();
    expect(EscrowListener).not.toHaveBeenCalled();
  });

  it('skips non-EventLog entries (isEventLog returns false)', async () => {
    (isEventLog as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    contractInstance.queryFilter.mockResolvedValue([{ args: ['0xescrow', REGISTRY, 1n] }]);
    await makeListener().start();
    expect(EscrowListener).not.toHaveBeenCalled();
  });

  it('logs skipped count when batches fail', async () => {
    contractInstance.queryFilter.mockRejectedValue(new Error('internal'));
    await makeListener().start();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: expect.any(Number) }),
      expect.stringContaining('skipped'),
    );
  });

  it('respects replayDelayMs between batches (not before first)', async () => {
    vi.useFakeTimers();
    mockGetBlockNumber.mockResolvedValue(2999);
    contractInstance.queryFilter.mockResolvedValue([]);
    const p = makeListener({ replayBatchSize: 1000, replayDelayMs: 50, replayFromBlock: 0 }).start();
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    await p;
    // 3 batches: blocks 0-999, 1000-1999, 2000-2999
    expect(contractInstance.queryFilter).toHaveBeenCalledTimes(3);
  });

  it('does not attach duplicate listeners for same escrow across batches', async () => {
    const escrow = '0xsameescrow000000000000000000000000000';
    const mockEvLog = { args: [escrow, REGISTRY, 1n] };
    mockGetBlockNumber.mockResolvedValue(1999);
    // Both batches return the same escrow
    contractInstance.queryFilter.mockResolvedValue([mockEvLog]);
    await makeListener({ replayBatchSize: 1000, replayFromBlock: 0 }).start();
    expect(EscrowListener).toHaveBeenCalledTimes(1);
  });
});
