import { describe, it, expect } from 'vitest';
import { toISOString } from '../utils/format.js';

describe('toISOString', () => {
  // ── Falsy inputs → null ──────────────────────────────────────────────────────

  it('returns null for null', () => {
    expect(toISOString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toISOString(undefined)).toBeNull();
  });

  it('returns null for empty string (falsy)', () => {
    expect(toISOString('')).toBeNull();
  });

  // ── String passthrough ───────────────────────────────────────────────────────

  it('returns an ISO string as-is (IPC-serialised date arrives as string)', () => {
    const iso = '2024-01-15T10:30:00.000Z';
    expect(toISOString(iso)).toBe(iso);
  });

  it('returns any non-empty string unchanged', () => {
    expect(toISOString('not-a-date')).toBe('not-a-date');
  });

  // ── Date → string conversion ─────────────────────────────────────────────────

  it('converts a Date object to its ISO string representation', () => {
    const date = new Date('2024-06-01T00:00:00.000Z');
    expect(toISOString(date)).toBe('2024-06-01T00:00:00.000Z');
  });

  it('round-trips: toISOString(new Date(iso)) === iso', () => {
    const iso = '2025-03-20T12:00:00.000Z';
    expect(toISOString(new Date(iso))).toBe(iso);
  });

  it('preserves millisecond precision', () => {
    const date = new Date('2024-01-01T00:00:00.123Z');
    expect(toISOString(date)).toBe('2024-01-01T00:00:00.123Z');
  });
});
