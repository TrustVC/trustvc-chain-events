import { z } from 'zod';
import { CHAIN_CATALOG_BY_KEY } from '../chains/catalog.js';

const chainKeys = [...CHAIN_CATALOG_BY_KEY.keys()] as [string, ...string[]];

export const ChainConfigSchema = z.object({
  chainKey: z.enum(chainKeys),
  rpcUrl: z
    .string()
    .url()
    .refine(
      (url) =>
        url.startsWith('wss://') || url.startsWith('ws://') || url.startsWith('https://') || url.startsWith('http://'),
      { message: 'rpcUrl must be wss://, ws://, https://, or http://' },
    ),
  registryAddresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address')).default([]),
  pollIntervalMs: z.number().int().positive().optional(),
  replayFromBlock: z.number().int().min(0).optional(),
  replayBatchSize: z.number().int().min(1).max(10_000).default(2_000),
  replayDelayMs: z.number().int().min(0).default(0),
  confirmations: z.number().int().min(1).max(12).default(1),
});

export const WebhookConfigSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().default(10_000),
  retryAttempts: z.number().int().min(0).max(10).default(3),
  retryBackoffMs: z.number().int().positive().default(1_000),
  headers: z.record(z.string()).optional(),
  // Max simultaneous in-flight deliveries before queuing
  maxConcurrentDeliveries: z.number().int().min(1).max(100).default(10),
  // Max events held in the in-memory queue; extras are dropped and logged
  maxQueueSize: z.number().int().min(100).max(100_000).default(10_000),
});

export const AppConfigSchema = z.object({
  chains: z.array(ChainConfigSchema).min(1, 'At least one chain must be configured'),
  webhook: WebhookConfigSchema,
  // Directory where per-chain block-progress files are written to survive restarts
  stateDir: z.string().default('./.state'),
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(8080),
      host: z.string().default('0.0.0.0'),
      // Spawn each chain in its own child process for fault isolation
      workerProcesses: z.boolean().default(true),
    })
    .default({}),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
