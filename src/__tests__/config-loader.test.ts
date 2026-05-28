import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/loader.js';

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

const VALID_ADDRESS = '0xe6b5ce7E3691a0927b2806CE6638b35237DFfAc4';
const validConfig = {
  chains: [
    {
      chainKey: 'ethereum-sepolia',
      rpcUrl: 'wss://sepolia.drpc.org',
      registryAddresses: [VALID_ADDRESS],
    },
  ],
  webhook: { url: 'https://example.com/webhook' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('loads and parses valid config file', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(validConfig));
    const config = loadConfig();
    expect(config.chains[0].chainKey).toBe('ethereum-sepolia');
    expect(config.webhook.url).toBe('https://example.com/webhook');
  });

  it('throws when config file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    expect(() => loadConfig()).toThrow('Failed to read config');
  });

  it('throws when config contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('{ invalid json }');
    expect(() => loadConfig()).toThrow('Failed to read config');
  });

  it('throws with "Config validation failed" when validation fails', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ chains: [], webhook: { url: 'https://x.com' } }));
    expect(() => loadConfig()).toThrow('Config validation failed');
  });

  it('formats Zod error paths with dot notation (e.g. chains.0.chainKey)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        ...validConfig,
        chains: [{ ...validConfig.chains[0], chainKey: 'not-a-valid-chain' }],
      }),
    );
    expect(() => loadConfig()).toThrow('chains.0');
  });

  it('interpolates ${VAR} env vars in config content', () => {
    vi.stubEnv('TEST_RPC_URL', 'wss://sepolia.drpc.org');
    const raw = JSON.stringify(validConfig).replace('wss://sepolia.drpc.org', '${TEST_RPC_URL}');
    mockReadFileSync.mockReturnValue(raw);
    expect(() => loadConfig()).not.toThrow();
  });

  it('interpolates multiple different env vars', () => {
    vi.stubEnv('MY_RPC', 'wss://sepolia.drpc.org');
    vi.stubEnv('MY_WEBHOOK', 'https://example.com/webhook');
    const raw = `{"chains":[{"chainKey":"ethereum-sepolia","rpcUrl":"\${MY_RPC}","registryAddresses":["${VALID_ADDRESS}"]}],"webhook":{"url":"\${MY_WEBHOOK}"}}`;
    mockReadFileSync.mockReturnValue(raw);
    expect(() => loadConfig()).not.toThrow();
  });

  it('throws when interpolated env var is not set', () => {
    delete process.env['UNSET_VAR_XYZ'];
    const raw = JSON.stringify(validConfig).replace('wss://sepolia.drpc.org', '${UNSET_VAR_XYZ}');
    mockReadFileSync.mockReturnValue(raw);
    expect(() => loadConfig()).toThrow('UNSET_VAR_XYZ');
  });

  it('leaves strings without ${} tokens untouched', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify(validConfig));
    expect(() => loadConfig()).not.toThrow();
  });

  it('uses CONFIG_PATH env var when set (verified via readFileSync call)', async () => {
    vi.stubEnv('CONFIG_PATH', '/custom/myconfig.json');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify(validConfig)),
    }));
    const { loadConfig: freshLoad } = await import('../config/loader.js');
    const { readFileSync: freshFs } = await import('node:fs');
    freshLoad();
    const callPath = (freshFs as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(callPath).toContain('/custom/myconfig.json');
    vi.resetModules();
    vi.doUnmock('node:fs');
  });

  it('falls back to default config path when CONFIG_PATH not set', () => {
    delete process.env['CONFIG_PATH'];
    mockReadFileSync.mockReturnValue(JSON.stringify(validConfig));
    loadConfig();
    const callPath = mockReadFileSync.mock.calls[0][0] as string;
    expect(callPath).toContain('config.json');
  });
});
