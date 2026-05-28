import type { Logger } from 'pino';
import { ProviderFactory } from './rpc/provider-factory.js';
import type { ITransport } from './interfaces/transport.js';
import type { IWebhookEmitter } from './interfaces/emitter.js';
import type { ChainConfig } from './config/schema.js';
import type { ChainDef } from './chains/catalog.js';
import type { ProviderState } from './rpc/provider-state.js';

export interface ChainStatus {
  chainKey: string;
  chainId: number;
  transport: string;
  providerState: ProviderState;
  activeEscrows: number;
}

export class ChainManager {
  private readonly transport: ITransport;

  constructor(
    private readonly chainConfig: ChainConfig,
    private readonly chainDef: ChainDef,
    emitter: IWebhookEmitter,
    log: Logger,
    stateDir: string = './.state',
  ) {
    this.transport = new ProviderFactory(log, emitter, stateDir).create(chainConfig, chainDef);
  }

  get chainKey(): string {
    return this.chainDef.key;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  stop(): void {
    this.transport.stop();
  }

  getStatus(): ChainStatus {
    return {
      chainKey: this.chainDef.key,
      chainId: this.chainDef.chainId,
      transport: this.chainDef.transport,
      providerState: this.transport.getState(),
      activeEscrows: this.transport.activeEscrowCount,
    };
  }

  async addRegistry(address: string, fromBlock: number): Promise<void> {
    await this.transport.addRegistry(address, fromBlock);
  }
}
