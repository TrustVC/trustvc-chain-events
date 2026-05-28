import type { Provider } from 'ethers';
import type { Logger } from 'pino';
import { RegistryListener } from './registry-listener.js';
import { FactoryListener, type KnownEscrow } from './factory-listener.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { ChainConfig } from '../config/schema.js';
import type { ChainDef } from '../chains/catalog.js';
import { isProviderDestroyed } from '../rpc/provider-errors.js';
import { resolveFactoryAddress } from '../contracts/factory-resolver.js';
import { getDb } from '../db/connection.js';
import { readBlock, writeBlock } from '../db/repositories/block-repo.js';
import { loadEscrows } from '../db/repositories/escrow-repo.js';
import { loadRegistries } from '../db/repositories/registry-repo.js';

export type AttachAbortFn = () => boolean;

export class ListenerStack {
  private registryListeners: RegistryListener[] = [];
  private factoryListener: FactoryListener | null = null;
  private readonly knownEscrows = new Map<string, KnownEscrow>();
  private lastHistoricalReplayBlock: number | null = null;
  private dbSeeded = false;
  private readonly watchedRegistries = new Set<string>();
  private currentProvider: Provider | null = null;

  constructor(
    private readonly chainConfig: ChainConfig,
    private readonly chainDef: ChainDef,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
  ) {}

  async attach(provider: Provider, isAborted: AttachAbortFn = () => false): Promise<void> {
    this.detach();

    // On the very first connect, seed knownEscrows and the block cursor from DB
    // so the replay only covers the delta since the last checkpoint.
    if (!this.dbSeeded && getDb()) {
      const [persisted, lastBlock, dbRegistries] = await Promise.all([
        loadEscrows(this.chainDef.key),
        readBlock(this.chainDef.key),
        loadRegistries(this.chainDef.key),
      ]);
      for (const [addr, info] of persisted) {
        this.knownEscrows.set(addr, {
          escrowAddr: addr,
          registryAddr: info.registryAddress,
          tokenId: BigInt(info.tokenId),
        });
      }
      if (lastBlock !== null) this.lastHistoricalReplayBlock = lastBlock;
      for (const r of dbRegistries) this.watchedRegistries.add(r.address.toLowerCase());
      this.dbSeeded = true;
      this.log.info(
        { chain: this.chainDef.key, escrows: persisted.size, resumeFrom: lastBlock ?? 'config' },
        'DB seed complete — restored escrow cache and block cursor',
      );
    }

    // Seed config registries (idempotent across reconnects)
    for (const addr of this.chainConfig.registryAddresses) {
      this.watchedRegistries.add(addr.toLowerCase());
    }
    this.currentProvider = provider;

    const factoryAddress = await resolveFactoryAddress(this.chainConfig.registryAddresses, provider);
    this.log.debug({ chain: this.chainDef.key, factory: factoryAddress }, 'WS: resolved factory address');

    const registryListeners: RegistryListener[] = [];
    try {
      for (const registryAddress of this.chainConfig.registryAddresses) {
        if (isAborted()) return;
        const rl = new RegistryListener(
          registryAddress,
          this.chainDef.key,
          this.chainDef.chainId,
          provider,
          this.emitter,
          this.log,
          this.chainConfig.confirmations,
        );
        rl.start();
        registryListeners.push(rl);
      }

      if (isAborted()) return;

      const replayFrom =
        this.lastHistoricalReplayBlock !== null
          ? this.lastHistoricalReplayBlock + 1
          : (this.chainConfig.replayFromBlock ?? 0);

      const fl = new FactoryListener(
        factoryAddress,
        this.watchedRegistries,
        this.chainDef.key,
        this.chainDef.chainId,
        provider,
        this.emitter,
        this.log,
        replayFrom,
        this.chainConfig.replayBatchSize,
        this.chainConfig.replayDelayMs,
        this.chainConfig.confirmations,
        this.knownEscrows,
      );
      await fl.start(isAborted);
      if (isAborted()) return;

      this.registryListeners = registryListeners;
      this.factoryListener = fl;
      const replayedThrough = fl.getReplayedThroughBlock();
      if (replayedThrough !== null) {
        this.lastHistoricalReplayBlock = replayedThrough;
        if (getDb()) void writeBlock(this.chainDef.key, replayedThrough);
      }
    } catch (err) {
      if (!isProviderDestroyed(err)) throw err;
    } finally {
      if (isAborted()) this.detach();
    }
  }

  async addRegistry(address: string, fromBlock: number): Promise<void> {
    const key = address.toLowerCase();
    if (this.currentProvider) {
      const rl = new RegistryListener(
        address,
        this.chainDef.key,
        this.chainDef.chainId,
        this.currentProvider,
        this.emitter,
        this.log,
        this.chainConfig.confirmations,
      );
      rl.start();
      this.registryListeners.push(rl);
    }
    if (this.factoryListener) {
      // addWatchedRegistry owns adding to watchedRegistries + running the historical replay.
      // Do NOT pre-add to watchedRegistries here — the shared Set is checked inside
      // addWatchedRegistry for the early-return guard, so adding it first would skip replay.
      await this.factoryListener.addWatchedRegistry(key, fromBlock);
    } else {
      // Factory listener not running yet — add directly so new events are filtered correctly
      // once the factory listener starts.
      this.watchedRegistries.add(key);
    }
  }

  detach(): void {
    for (const rl of this.registryListeners) rl.stop();
    this.registryListeners = [];
    this.factoryListener?.stop();
    this.factoryListener = null;
  }

  get activeEscrowCount(): number {
    return this.factoryListener?.activeEscrowCount ?? 0;
  }
}
