import type { Logger } from 'pino';
import { WsConnection } from './ws-connection.js';
import { isProviderDestroyed } from './provider-errors.js';
import { ListenerStack } from '../listeners/listener-stack.js';
import type { ITransport } from '../interfaces/transport.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { ProviderState } from './provider-state.js';
import type { ChainConfig } from '../config/schema.js';
import type { ChainDef } from '../chains/catalog.js';

export class WsTransport implements ITransport {
  private readonly connection: WsConnection;
  private readonly listenerStack: ListenerStack;
  private attachSession = 0;
  private attachInFlight: Promise<void> | null = null;

  constructor(chainConfig: ChainConfig, chainDef: ChainDef, emitter: IWebhookEmitter, log: Logger) {
    this.connection = new WsConnection(chainConfig.rpcUrl, chainDef.pingIntervalMs, chainDef.key, log);
    this.listenerStack = new ListenerStack(chainConfig, chainDef, emitter, log);

    this.connection.setBeforeTeardown(async () => {
      this.attachSession++;
      if (this.attachInFlight) {
        await this.attachInFlight.catch(() => {});
      }
      this.listenerStack.detach();
    });

    this.connection.on('connected', (provider) => {
      const session = this.attachSession;
      this.attachInFlight = this.listenerStack
        .attach(provider, () => session !== this.attachSession)
        .catch((err) => {
          if (isProviderDestroyed(err)) return;
          log.warn(
            { chain: chainDef.key, err: err instanceof Error ? err.message : String(err) },
            'Listener attach failed',
          );
        });
    });

    this.connection.on('gapDetected', (fromBlock: number, toBlock: number) => {
      log.info(
        { chain: chainDef.key, fromBlock, toBlock },
        'Gap detected after reconnect — re-attach will replay missed events via eth_subscribe backfill',
      );
    });
  }

  async start(): Promise<void> {
    await this.connection.connect();
  }

  stop(): void {
    void this.stopAsync();
  }

  private async stopAsync(): Promise<void> {
    this.attachSession++;
    if (this.attachInFlight) {
      await this.attachInFlight.catch(() => {});
    }
    this.listenerStack.detach();
    await this.connection.destroy();
  }

  getState(): ProviderState {
    return this.connection.getState();
  }

  get activeEscrowCount(): number {
    return this.listenerStack.activeEscrowCount;
  }

  async addRegistry(address: string, fromBlock: number): Promise<void> {
    await this.listenerStack.addRegistry(address, fromBlock);
  }
}
