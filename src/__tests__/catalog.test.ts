import { describe, it, expect } from 'vitest';
import { CHAIN_CATALOG, CHAIN_CATALOG_BY_KEY, CHAIN_CATALOG_BY_ID } from '../chains/catalog.js';

describe('CHAIN_CATALOG', () => {
  it('all chains have unique key values', () => {
    const keys = CHAIN_CATALOG.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all chains have unique chainId values', () => {
    const ids = CHAIN_CATALOG.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all pollIntervalMs are positive integers', () => {
    for (const c of CHAIN_CATALOG) {
      expect(c.pollIntervalMs).toBeGreaterThan(0);
      expect(Number.isInteger(c.pollIntervalMs)).toBe(true);
    }
  });

  it('all pingIntervalMs are positive integers', () => {
    for (const c of CHAIN_CATALOG) {
      expect(c.pingIntervalMs).toBeGreaterThan(0);
      expect(Number.isInteger(c.pingIntervalMs)).toBe(true);
    }
  });

  it('stability and astron chains have transport http-polling', () => {
    const httpPollingKeys = ['stability', 'stability-testnet', 'astron', 'astron-testnet'];
    for (const key of httpPollingKeys) {
      expect(CHAIN_CATALOG_BY_KEY.get(key)?.transport).toBe('http-polling');
    }
  });

  it('ethereum and polygon chains have transport websocket', () => {
    const wsKeys = ['ethereum', 'ethereum-sepolia', 'polygon', 'polygon-amoy', 'xdc', 'xdc-apothem'];
    for (const key of wsKeys) {
      expect(CHAIN_CATALOG_BY_KEY.get(key)?.transport).toBe('websocket');
    }
  });
});

describe('CHAIN_CATALOG_BY_KEY', () => {
  it('has same size as CHAIN_CATALOG', () => {
    expect(CHAIN_CATALOG_BY_KEY.size).toBe(CHAIN_CATALOG.length);
  });

  it('lookup by key returns correct chain def', () => {
    const chain = CHAIN_CATALOG_BY_KEY.get('ethereum-sepolia');
    expect(chain?.chainId).toBe(11155111);
  });

  it('lookup by unknown key returns undefined', () => {
    expect(CHAIN_CATALOG_BY_KEY.get('unknown-chain')).toBeUndefined();
  });
});

describe('CHAIN_CATALOG_BY_ID', () => {
  it('has same size as CHAIN_CATALOG', () => {
    expect(CHAIN_CATALOG_BY_ID.size).toBe(CHAIN_CATALOG.length);
  });
});
