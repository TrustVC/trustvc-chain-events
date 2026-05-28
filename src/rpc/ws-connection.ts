import { EventEmitter } from 'node:events';
import { WebSocketProvider, JsonRpcProvider, type Provider } from 'ethers';
import { initialProviderState, backoffMs, BACKOFF_MAX_ATTEMPTS, type ProviderState } from './provider-state.js';
import type { Logger } from 'pino';
import { meter } from '../telemetry/index.js';

const rpcConnects = meter.createCounter('trustvc.rpc.connects', {
  description: 'Successful RPC connections per chain',
});
const rpcDisconnects = meter.createCounter('trustvc.rpc.disconnects', {
  description: 'RPC disconnections and reconnect attempts per chain',
});

export class WsConnection extends EventEmitter {
  private provider: Provider | null = null;
  private wsProvider: WebSocketProvider | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeInFlight: Promise<void> | null = null;
  private state: ProviderState;
  private destroyed = false;
  private tearingDown = false;
  private connectedAt: number | null = null;
  private beforeTeardown: (() => void | Promise<void>) | null = null;

  constructor(
    private readonly rpcUrl: string,
    private readonly pingIntervalMs: number,
    private readonly chainKey: string,
    private readonly log: Logger,
  ) {
    super();
    this.state = initialProviderState();
  }

  getState(): ProviderState {
    return this.state;
  }

  getProvider(): Provider | null {
    return this.provider;
  }

  setBeforeTeardown(fn: () => void | Promise<void>): void {
    this.beforeTeardown = fn;
  }

  async connect(): Promise<void> {
    if (!this.destroyed) await this.attemptConnect();
  }

  private async attemptConnect(): Promise<void> {
    if (this.destroyed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeInFlight) await this.closeInFlight;
    await this.runBeforeTeardown();
    this.teardownWsProvider();

    const isWs = this.rpcUrl.startsWith('wss://') || this.rpcUrl.startsWith('ws://');
    const transport = isWs ? 'websocket' : 'http';
    this.log.info({ chain: this.chainKey, transport }, 'Connecting to RPC');
    this.state.status = 'connecting';

    try {
      let provider: Provider;
      if (isWs) {
        const ws = new WebSocketProvider(this.rpcUrl);
        await ws.ready;
        this.wsProvider = ws;
        provider = ws;
      } else {
        provider = new JsonRpcProvider(this.rpcUrl);
      }

      this.provider = provider;
      const currentBlock = await provider.getBlockNumber();

      if (this.state.lastSeenBlock !== null && currentBlock > this.state.lastSeenBlock + 1) {
        this.emit('gapDetected', this.state.lastSeenBlock + 1, currentBlock);
      }

      this.state.status = 'connected';
      this.state.lastConnectedAt = new Date();
      this.state.reconnectAttempts = 0;
      this.state.lastError = null;
      this.state.lastSeenBlock = currentBlock;

      if (isWs) {
        const ws = provider as WebSocketProvider;
        ws.on('error', (err: unknown) => {
          if (this.tearingDown) return;
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn({ chain: this.chainKey, err: msg }, 'WebSocket error');
          this.handleDisconnect();
        });
        ws.on('block', (n: number) => {
          this.state.lastSeenBlock = n;
          this.emit('block', n);
        });
      }

      this.connectedAt = Date.now();
      this.startPing();
      rpcConnects.add(1, { chain: this.chainKey, transport });
      this.emit('connected', provider, this.state);
      this.log.info({ chain: this.chainKey, block: currentBlock }, 'RPC connected');
    } catch (err) {
      this.handleError(err);
    }
  }

  private handleDisconnect(): void {
    if (this.destroyed) return;
    void this.closeConnection();
  }

  private handleError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log.warn({ chain: this.chainKey, err: msg }, 'RPC connection error');
    this.state.lastError = msg;
    this.state.lastErrorAt = new Date();
    this.state.reconnectAttempts += 1;

    if (this.state.reconnectAttempts >= BACKOFF_MAX_ATTEMPTS) {
      void this.finalizeFailedConnection();
      return;
    }

    void this.closeConnection();
  }

  private async finalizeFailedConnection(): Promise<void> {
    this.stopPing();
    this.provider = null;
    await this.runBeforeTeardown();
    this.teardownWsProvider();
    this.state.status = 'failed';
    this.emit('failed', this.state);
    this.log.error({ chain: this.chainKey }, 'RPC permanently failed after max retries');
  }

  private async closeConnection(): Promise<void> {
    if (this.destroyed) return;
    if (this.closeInFlight) return this.closeInFlight;
    this.closeInFlight = this.doCloseConnection();
    try {
      await this.closeInFlight;
    } finally {
      this.closeInFlight = null;
    }
  }

  private async doCloseConnection(): Promise<void> {
    this.stopPing();
    this.provider = null;
    const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
    this.connectedAt = null;
    if (uptimeMs > 0 && uptimeMs < 15_000) {
      this.state.reconnectAttempts = Math.min(this.state.reconnectAttempts + 1, BACKOFF_MAX_ATTEMPTS - 1);
      this.log.warn(
        { chain: this.chainKey, uptimeMs },
        'WebSocket closed soon after connect — likely RPC subscription limit; backing off',
      );
    }
    await this.runBeforeTeardown();
    this.teardownWsProvider();
    rpcDisconnects.add(1, { chain: this.chainKey });
    this.state.status = 'reconnecting';
    this.state.lastErrorAt = new Date();
    this.emit('disconnected', this.state);
    this.scheduleReconnect();
  }

  private async runBeforeTeardown(): Promise<void> {
    if (!this.beforeTeardown) return;
    try {
      await this.beforeTeardown();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ chain: this.chainKey, err: msg }, 'beforeTeardown hook failed');
    }
  }

  private teardownWsProvider(): void {
    if (!this.wsProvider) return;
    this.tearingDown = true;
    this.wsProvider.removeAllListeners();
    this.wsProvider.destroy();
    this.wsProvider = null;
    this.tearingDown = false;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    const delay = backoffMs(this.state.reconnectAttempts);
    this.log.info({ chain: this.chainKey, delay, attempt: this.state.reconnectAttempts }, 'Scheduling reconnect');
    this.reconnectTimer = setTimeout(() => this.attemptConnect(), delay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(async () => {
      if (!this.provider) return;
      try {
        this.state.lastSeenBlock = await this.provider.getBlockNumber();
      } catch {
        this.handleDisconnect();
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.closeInFlight) await this.closeInFlight;
    await this.runBeforeTeardown();
    this.teardownWsProvider();
    this.provider = null;
    this.removeAllListeners();
  }
}
