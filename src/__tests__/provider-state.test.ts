import { describe, it, expect } from 'vitest';
import { initialProviderState, backoffMs, BACKOFF_MAX_MS } from '../rpc/provider-state.js';

describe('initialProviderState', () => {
  it('returns status connecting', () => {
    expect(initialProviderState().status).toBe('connecting');
  });

  it('all nullable fields are null or zero', () => {
    const s = initialProviderState();
    expect(s.lastConnectedAt).toBeNull();
    expect(s.lastErrorAt).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.reconnectAttempts).toBe(0);
    expect(s.lastSeenBlock).toBeNull();
  });
});

describe('backoffMs', () => {
  it('attempt 0 → 1000ms', () => {
    expect(backoffMs(0)).toBe(1_000);
  });

  it('attempt 1 → 2000ms', () => {
    expect(backoffMs(1)).toBe(2_000);
  });

  it('attempt 5 → 32000ms', () => {
    expect(backoffMs(5)).toBe(32_000);
  });

  it('attempt 10 → capped at 60000ms', () => {
    expect(backoffMs(10)).toBe(BACKOFF_MAX_MS);
  });

  it('very high attempt → still capped at 60000ms', () => {
    expect(backoffMs(100)).toBe(BACKOFF_MAX_MS);
  });
});
