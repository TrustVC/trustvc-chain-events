import { describe, it, expect } from 'vitest';
import { isProviderDestroyed } from '../rpc/provider-errors.js';

describe('isProviderDestroyed', () => {
  it('detects cancelled eth_subscribe on destroyed provider', () => {
    const err = {
      code: 'UNSUPPORTED_OPERATION',
      operation: 'eth_subscribe',
      shortMessage: 'provider destroyed; cancelled request',
    };
    expect(isProviderDestroyed(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isProviderDestroyed(new Error('network error'))).toBe(false);
  });
});
