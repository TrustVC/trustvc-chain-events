import type { Logger } from 'pino';
import { WsTransport } from './ws-transport.js';
import { HttpTransport } from './http-transport.js';
import type { ITransport } from '../interfaces/transport.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { ChainConfig } from '../config/schema.js';
import type { ChainDef } from '../chains/catalog.js';

export class ProviderFactory {
  constructor(
    private readonly log: Logger,
    private readonly emitter: IWebhookEmitter,
    private readonly stateDir: string = './.state',
  ) {}

  create(chainConfig: ChainConfig, chainDef: ChainDef): ITransport {
    const rpcUrl = chainConfig.rpcUrl.toLowerCase();
    const useHttp =
      chainDef.transport === 'http-polling' || rpcUrl.startsWith('https://') || rpcUrl.startsWith('http://');
    if (useHttp) {
      return new HttpTransport(chainConfig, chainDef, this.emitter, this.log, this.stateDir);
    }
    return new WsTransport(chainConfig, chainDef, this.emitter, this.log);
  }
}
