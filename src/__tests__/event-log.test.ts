import { describe, it, expect } from 'vitest';
import { EventLog } from 'ethers';
import { isEventLog } from '../contracts/event-log.js';
import type { Log } from 'ethers';

describe('isEventLog', () => {
  it('returns true for an EventLog instance', () => {
    const evLog = Object.create(EventLog.prototype) as EventLog;
    expect(isEventLog(evLog as unknown as Log)).toBe(true);
  });

  it('returns false for a plain object', () => {
    expect(isEventLog({} as Log)).toBe(false);
  });
});
