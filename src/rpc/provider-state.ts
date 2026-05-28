export type ProviderStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface ProviderState {
  status: ProviderStatus;
  lastConnectedAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  reconnectAttempts: number;
  lastSeenBlock: number | null;
}

export function initialProviderState(): ProviderState {
  return {
    status: 'connecting',
    lastConnectedAt: null,
    lastErrorAt: null,
    lastError: null,
    reconnectAttempts: 0,
    lastSeenBlock: null,
  };
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
// After this many attempts the delay stays at BACKOFF_MAX_MS — used as a circuit-breaker guard.
export const BACKOFF_MAX_ATTEMPTS = 10;

// Pure exponential backoff: 1 s → 2 s → 4 s → … → 60 s (capped).
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}
