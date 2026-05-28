import { describe, it, expect } from 'vitest';
import { toNormalizedLog } from '../utils/eth.js';

const SAMPLE = {
  blockNumber: 12_345_678,
  transactionHash: '0xabc123def456',
  index: 3,
  address: '0xDeAdBeEf',
};

describe('toNormalizedLog', () => {
  it('maps blockNumber correctly', () => {
    expect(toNormalizedLog(SAMPLE).blockNumber).toBe(12_345_678);
  });

  it('maps transactionHash correctly', () => {
    expect(toNormalizedLog(SAMPLE).transactionHash).toBe('0xabc123def456');
  });

  it('maps index → logIndex (field is renamed)', () => {
    // ethers EventLog uses `.index`; NormalizedLog uses `.logIndex`
    expect(toNormalizedLog(SAMPLE).logIndex).toBe(3);
  });

  it('maps address correctly', () => {
    expect(toNormalizedLog(SAMPLE).address).toBe('0xDeAdBeEf');
  });

  it('returns an object with exactly the four NormalizedLog fields', () => {
    const result = toNormalizedLog(SAMPLE);
    expect(Object.keys(result).sort()).toEqual(['address', 'blockNumber', 'logIndex', 'transactionHash']);
  });

  it('does not mutate the input object', () => {
    const input = { ...SAMPLE };
    toNormalizedLog(input);
    expect(input).toEqual(SAMPLE);
  });

  it('handles logIndex=0 (falsy value preserved)', () => {
    expect(toNormalizedLog({ ...SAMPLE, index: 0 }).logIndex).toBe(0);
  });

  it('handles blockNumber=0', () => {
    expect(toNormalizedLog({ ...SAMPLE, blockNumber: 0 }).blockNumber).toBe(0);
  });
});
