import { describe, it, expect } from 'vitest';
import { ChainConfigSchema, WebhookConfigSchema, AppConfigSchema } from '../config/schema.js';

const VALID_ADDRESS = '0xe6b5ce7E3691a0927b2806CE6638b35237DFfAc4';

const baseChain = {
  chainKey: 'ethereum-sepolia',
  rpcUrl: 'wss://sepolia.drpc.org',
  registryAddresses: [VALID_ADDRESS],
};

const baseWebhook = { url: 'https://example.com/webhook' };

describe('ChainConfigSchema', () => {
  it('accepts valid minimal chain config', () => {
    expect(ChainConfigSchema.safeParse(baseChain).success).toBe(true);
  });

  it('rejects unknown chainKey', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, chainKey: 'unknown-xyz' }).success).toBe(false);
  });

  it('accepts wss:// rpcUrl', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, rpcUrl: 'wss://node.example.com' }).success).toBe(true);
  });

  it('accepts https:// rpcUrl', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, rpcUrl: 'https://node.example.com' }).success).toBe(true);
  });

  it('rejects ftp:// rpcUrl', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, rpcUrl: 'ftp://node.example.com' }).success).toBe(false);
  });

  it('accepts empty registryAddresses array', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, registryAddresses: [] }).success).toBe(true);
  });

  it('rejects invalid address format (too short)', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, registryAddresses: ['0x1234'] }).success).toBe(false);
  });

  it('rejects address without 0x prefix', () => {
    expect(
      ChainConfigSchema.safeParse({ ...baseChain, registryAddresses: ['e6b5ce7E3691a0927b2806CE6638b35237DFfAc4'] })
        .success,
    ).toBe(false);
  });

  it('accepts valid EVM address', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, registryAddresses: [VALID_ADDRESS] }).success).toBe(true);
  });

  it('defaults replayBatchSize to 2000', () => {
    const result = ChainConfigSchema.parse(baseChain);
    expect(result.replayBatchSize).toBe(2_000);
  });

  it('rejects replayBatchSize > 10000', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, replayBatchSize: 10_001 }).success).toBe(false);
  });

  it('rejects replayBatchSize < 1', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, replayBatchSize: 0 }).success).toBe(false);
  });

  it('defaults replayDelayMs to 0', () => {
    expect(ChainConfigSchema.parse(baseChain).replayDelayMs).toBe(0);
  });

  it('defaults confirmations to 1', () => {
    expect(ChainConfigSchema.parse(baseChain).confirmations).toBe(1);
  });

  it('rejects confirmations < 1', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, confirmations: 0 }).success).toBe(false);
  });

  it('rejects confirmations > 12', () => {
    expect(ChainConfigSchema.safeParse({ ...baseChain, confirmations: 13 }).success).toBe(false);
  });
});

describe('WebhookConfigSchema', () => {
  it('accepts valid webhook config', () => {
    expect(WebhookConfigSchema.safeParse(baseWebhook).success).toBe(true);
  });

  it('rejects non-URL url field', () => {
    expect(WebhookConfigSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });

  it('defaults timeoutMs to 10000', () => {
    expect(WebhookConfigSchema.parse(baseWebhook).timeoutMs).toBe(10_000);
  });

  it('defaults retryAttempts to 3', () => {
    expect(WebhookConfigSchema.parse(baseWebhook).retryAttempts).toBe(3);
  });

  it('rejects retryAttempts > 10', () => {
    expect(WebhookConfigSchema.safeParse({ ...baseWebhook, retryAttempts: 11 }).success).toBe(false);
  });

  it('accepts optional headers record', () => {
    const result = WebhookConfigSchema.parse({ ...baseWebhook, headers: { Authorization: 'Bearer token' } });
    expect(result.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('omits headers when not provided', () => {
    expect(WebhookConfigSchema.parse(baseWebhook).headers).toBeUndefined();
  });
});

describe('AppConfigSchema', () => {
  const baseApp = { chains: [baseChain], webhook: baseWebhook };

  it('rejects config with empty chains array', () => {
    expect(AppConfigSchema.safeParse({ ...baseApp, chains: [] }).success).toBe(false);
  });

  it('defaults server.port to 8080', () => {
    expect(AppConfigSchema.parse(baseApp).server.port).toBe(8080);
  });

  it('defaults server.host to 0.0.0.0', () => {
    expect(AppConfigSchema.parse(baseApp).server.host).toBe('0.0.0.0');
  });

  it('rejects server.port > 65535', () => {
    expect(AppConfigSchema.safeParse({ ...baseApp, server: { port: 65536 } }).success).toBe(false);
  });

  it('defaults logLevel to info', () => {
    expect(AppConfigSchema.parse(baseApp).logLevel).toBe('info');
  });

  it('rejects unknown logLevel', () => {
    expect(AppConfigSchema.safeParse({ ...baseApp, logLevel: 'verbose' }).success).toBe(false);
  });
});
