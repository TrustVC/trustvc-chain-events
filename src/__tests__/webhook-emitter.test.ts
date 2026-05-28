import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebhookEmitter } from '../delivery/webhook-emitter.js';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import type { SigningKeyManager } from '../signing/signing-key.js';
import type { WebhookConfig } from '../config/schema.js';

const mockEvent: CloudEvent = {
  specversion: '1.0',
  id: 'test-id',
  source: 'urn:trustvc:1:0xabc',
  type: 'com.trustvc.etr.minted',
  datacontenttype: 'application/json',
  time: '2024-01-01T00:00:00.000Z',
  subject: '1',
  data: {
    chainKey: 'ethereum',
    chainId: 1,
    registryAddress: '0xabc',
    tokenId: '1',
    blockNumber: 100,
    transactionHash: '0xtx',
    logIndex: 0,
    payload: {},
    idempotencyKey: '1-0xtx-0',
  },
};

const mockSigner: SigningKeyManager = {
  sign: vi.fn().mockReturnValue('mock-sig'),
};

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const baseConfig: WebhookConfig = {
  url: 'https://example.com/webhook',
  timeoutMs: 30_000,
  retryAttempts: 0,
  retryBackoffMs: 100,
  maxConcurrentDeliveries: 10,
  maxQueueSize: 10_000,
};

function makeOkResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse(200)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createWebhookEmitter', () => {
  // ── Delivery happy-path ───────────────────────────────────────────────────

  it('delivers successfully on first attempt', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('fetch is called once after successful delivery', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    expect(fetch).not.toHaveBeenCalled();
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sets X-TrustVC-Signature header to ed25519=<sig>', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['X-TrustVC-Signature']).toBe('ed25519=mock-sig');
  });

  it('sets Content-Type: application/json header', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('merges custom config headers into request', async () => {
    const config: WebhookConfig = { ...baseConfig, headers: { Authorization: 'Bearer token' } };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer token');
  });

  // ── Retry behaviour ───────────────────────────────────────────────────────

  it('retries on HTTP 4xx response', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeOkResponse(429)).mockResolvedValueOnce(makeOkResponse(200));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 1, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ eventId: mockEvent.id }), 'Webhook delivered');
  });

  it('retries on HTTP 5xx response', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(makeOkResponse(503)).mockResolvedValueOnce(makeOkResponse(200));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 1, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ eventId: mockEvent.id }), 'Webhook delivered');
  });

  it('stops retrying after retryAttempts exhausted', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeOkResponse(500));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 2, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: mockEvent.id }),
      'Webhook delivery exhausted',
    );
  });

  it('logs error after exhausting retries', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeOkResponse(500));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 1, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: mockEvent.id }),
      'Webhook delivery exhausted',
    );
  });

  it('retry delay doubles per attempt (exponential backoff)', async () => {
    vi.useFakeTimers();
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(makeOkResponse(500));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 2, retryBackoffMs: 1000 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);

    emitter.emit(mockEvent);

    // First attempt fires immediately (no pre-delay on attempt 1)
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // backoff = 1000 * 2^0 = 1000 ms before second attempt
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // backoff = 1000 * 2^1 = 2000 ms before third attempt
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Let doDeliver finish and the drain poll cycle complete
    await vi.advanceTimersByTimeAsync(100);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('aborts fetch after timeoutMs', async () => {
    vi.useFakeTimers();
    let abortFired = false;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            abortFired = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const config: WebhookConfig = { ...baseConfig, timeoutMs: 5_000, retryAttempts: 0 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    // Trigger the AbortController timeout, then drain all resulting microtasks
    await vi.advanceTimersByTimeAsync(5_001);
    expect(abortFired).toBe(true);
  });

  it('logs warn and exhaustion error on network fetch error (ECONNREFUSED)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'ECONNREFUSED' }), expect.any(String));
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: mockEvent.id }),
      'Webhook delivery exhausted',
    );
  });

  it('signature is computed once and reused across retries', async () => {
    const signMock = vi.fn().mockReturnValue('sig-once');
    const signer: SigningKeyManager = { sign: signMock };
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeOkResponse(503))
      .mockResolvedValueOnce(makeOkResponse(200));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 1, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, signer, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(signMock).toHaveBeenCalledTimes(1);
  });

  it('fetch is called once after delivery', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetch is called N+1 times for retryAttempts=N', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeOkResponse(500));
    const config: WebhookConfig = { ...baseConfig, retryAttempts: 2, retryBackoffMs: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(3); // 1 + retryAttempts
  });

  // ── Queue model edge cases ─────────────────────────────────────────────────

  it('emit() returns { success: true, attempts: 0 } immediately (fire-and-forget enqueue)', async () => {
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    const result = await emitter.emit(mockEvent);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(0);
    await emitter.drain();
  });

  it('emit() returns { success: false, error: "queue full" } when queue is at capacity', async () => {
    // Keep the worker permanently busy so the queue fills up (we only test the drop, not drain)
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const config: WebhookConfig = { ...baseConfig, maxQueueSize: 1, maxConcurrentDeliveries: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);

    emitter.emit(mockEvent); // taken by worker immediately
    emitter.emit({ ...mockEvent, id: 'queued' }); // fills the queue (pending.length = 1)
    const dropped = await emitter.emit({ ...mockEvent, id: 'dropped' }); // exceeds maxQueueSize

    expect(dropped.success).toBe(false);
    expect(dropped.error).toBe('queue full');
  });

  it('queueSize reflects number of pending (not yet active) events', async () => {
    // Each fetch resolves after a short delay; all three will naturally complete
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ ok: boolean; status: number }>((r) => setTimeout(() => r(makeOkResponse(200)), 10)),
    );
    const config: WebhookConfig = { ...baseConfig, maxConcurrentDeliveries: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);

    emitter.emit(mockEvent); // taken by worker immediately → queueSize stays 0
    emitter.emit({ ...mockEvent, id: 'e2' }); // worker busy → queueSize = 1
    emitter.emit({ ...mockEvent, id: 'e3' }); // worker busy → queueSize = 2
    expect(emitter.queueSize).toBe(2);

    await emitter.drain();
    expect(emitter.queueSize).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('delivers multiple events in FIFO order with maxConcurrentDeliveries=1', async () => {
    const order: string[] = [];
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((_url: string, opts: { body: string }) => {
      order.push((JSON.parse(opts.body) as CloudEvent).id);
      return Promise.resolve(makeOkResponse(200));
    });
    const config: WebhookConfig = { ...baseConfig, maxConcurrentDeliveries: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);

    emitter.emit({ ...mockEvent, id: 'a' });
    emitter.emit({ ...mockEvent, id: 'b' });
    emitter.emit({ ...mockEvent, id: 'c' });
    await emitter.drain();

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('maxConcurrentDeliveries caps simultaneous in-flight HTTP requests', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number }>((r) => {
          inFlight++;
          maxObserved = Math.max(maxObserved, inFlight);
          setTimeout(() => {
            inFlight--;
            r(makeOkResponse(200));
          }, 10);
        }),
    );
    const config: WebhookConfig = { ...baseConfig, maxConcurrentDeliveries: 2 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    for (let i = 0; i < 6; i++) emitter.emit({ ...mockEvent, id: `e${i}` });
    await emitter.drain();
    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('drain(0) returns without waiting for in-flight deliveries to complete', async () => {
    let unblockFetch!: () => void;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{ ok: boolean; status: number }>((r) => {
          unblockFetch = () => r(makeOkResponse(200));
        }),
    );
    const emitter = createWebhookEmitter(baseConfig, mockSigner, mockLog as never);
    emitter.emit(mockEvent);
    await emitter.drain(0); // returns immediately
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.anything(), 'Webhook delivered'); // delivery still in-flight

    unblockFetch();
    await emitter.drain(); // now wait for real
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('logs error immediately when queue is full (dropped event)', () => {
    // Keep the worker permanently busy; we only check the synchronous drop log
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const config: WebhookConfig = { ...baseConfig, maxQueueSize: 1, maxConcurrentDeliveries: 1 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);

    emitter.emit(mockEvent); // worker takes it
    emitter.emit({ ...mockEvent, id: 'queued' }); // fills queue
    emitter.emit({ ...mockEvent, id: 'dropped' }); // dropped → error logged synchronously

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'dropped' }),
      'Webhook queue full — dropping event',
    );
  });

  it('delivers all events when emitting more than maxConcurrentDeliveries at once', async () => {
    const config: WebhookConfig = { ...baseConfig, maxConcurrentDeliveries: 3 };
    const emitter = createWebhookEmitter(config, mockSigner, mockLog as never);
    for (let i = 0; i < 10; i++) emitter.emit({ ...mockEvent, id: `ev${i}` });
    await emitter.drain();
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(mockLog.error).not.toHaveBeenCalled();
  });
});
