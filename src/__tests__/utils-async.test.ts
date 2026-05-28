import { describe, it, expect, vi, afterEach } from 'vitest';
import { sleep } from '../utils/async.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sleep', () => {
  it('returns a Promise', () => {
    const result = sleep(0);
    expect(result).toBeInstanceOf(Promise);
    return result; // let vitest await so the timer fires
  });

  it('resolves after the specified delay (fake timers)', async () => {
    vi.useFakeTimers();
    let resolved = false;

    const p = sleep(1_000).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves immediately for sleep(0)', async () => {
    vi.useFakeTimers();
    let resolved = false;

    const p = sleep(0).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it('each call creates an independent timer', async () => {
    vi.useFakeTimers();
    const order: number[] = [];

    const p1 = sleep(200).then(() => order.push(1));
    const p2 = sleep(100).then(() => order.push(2));

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([p1, p2]);

    expect(order).toEqual([2, 1]); // shorter delay resolves first
  });
});
