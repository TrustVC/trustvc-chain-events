import { Contract, type ContractEventPayload, type Provider } from 'ethers';
import type { Logger } from 'pino';
import { FACTORY_ABI } from '../contracts/abis.js';
import { isEventLog } from '../contracts/event-log.js';
import { normalizeFactoryEvent } from '../delivery/event-normalizer.js';
import { EscrowListener } from './escrow-listener.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import { isProviderDestroyed, isRateLimit } from '../rpc/provider-errors.js';
import { toNormalizedLog } from '../utils/eth.js';
import type { AttachAbortFn } from './listener-stack.js';
import { getDb } from '../db/connection.js';
import { saveEscrow, markShredded } from '../db/repositories/escrow-repo.js';

// Persisted across reconnects so historical escrows are re-attached without a full replay.
export interface KnownEscrow {
  escrowAddr: string;
  registryAddr: string;
  tokenId: bigint;
}

export class FactoryListener {
  private readonly contract: Contract;
  private readonly escrowListeners = new Map<string, EscrowListener>();
  private replayedThroughBlock: number | null = null;

  constructor(
    private readonly factoryAddress: string,
    private readonly watchedRegistries: Set<string>,
    private readonly chainKey: string,
    private readonly chainId: number,
    private readonly provider: Provider,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
    private readonly replayFromBlock: number = 0,
    private readonly replayBatchSize: number = 2_000,
    private readonly replayDelayMs: number = 0,
    private readonly confirmations: number = 1,
    private readonly knownEscrows: Map<string, KnownEscrow> = new Map(),
  ) {
    this.contract = new Contract(factoryAddress, FACTORY_ABI, provider);
  }

  getReplayedThroughBlock(): number | null {
    return this.replayedThroughBlock;
  }

  // Start order matters: replay first (populate knownEscrows), then reattach
  // survivors from a prior connection, then subscribe to new ones going forward.
  async start(isAborted: AttachAbortFn = () => false): Promise<void> {
    await this.replayHistoricalEscrows(isAborted);
    if (isAborted()) return;
    this.reattachKnownEscrows(isAborted);
    if (isAborted()) return;
    this.subscribeToNewEscrows();
  }

  private async replayHistoricalEscrows(isAborted: AttachAbortFn): Promise<void> {
    const filterFn = this.contract.filters['TitleEscrowCreated'];
    if (!filterFn) {
      this.log.warn({ chain: this.chainKey }, 'TitleEscrowCreated filter not found — skipping replay');
      return;
    }

    let currentBlock: number;
    try {
      currentBlock = await this.provider.getBlockNumber();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ chain: this.chainKey, err: msg }, 'Could not fetch block number — skipping replay');
      return;
    }

    const from = this.replayFromBlock;
    if (from > currentBlock) {
      this.log.info({ chain: this.chainKey, from, to: currentBlock }, 'Escrow sync skipped — already caught up');
      return;
    }

    this.log.info({ chain: this.chainKey, from, to: currentBlock }, 'Starting escrow sync');

    let found = 0;
    let skipped = 0;
    let first = true;

    for (let batchFrom = from; batchFrom <= currentBlock; batchFrom += this.replayBatchSize) {
      if (isAborted()) return;
      if (!first && this.replayDelayMs > 0) await new Promise((r) => setTimeout(r, this.replayDelayMs));
      first = false;

      const batchTo = Math.min(batchFrom + this.replayBatchSize - 1, currentBlock);
      const logs = await this.queryFilterWithRetry(filterFn, batchFrom, batchTo);
      if (logs === null) {
        skipped++;
        continue;
      }

      for (const evLog of logs) {
        if (!isEventLog(evLog)) continue;
        const escrowAddr = evLog.args[0] as string;
        const registryAddr = evLog.args[1] as string;
        const tokenId = evLog.args[2] as bigint;
        if (this.watchedRegistries.has(registryAddr.toLowerCase())) {
          const isNew = !this.knownEscrows.has(escrowAddr.toLowerCase());
          this.attachEscrowListener(escrowAddr, registryAddr, tokenId);
          if (isNew && getDb()) {
            void saveEscrow(
              this.chainKey,
              escrowAddr.toLowerCase(),
              registryAddr,
              tokenId.toString(),
              evLog.blockNumber,
            );
          }
          found++;
        }
      }
    }

    this.replayedThroughBlock = currentBlock;
    this.log.info(
      { chain: this.chainKey, found, skipped },
      skipped > 0
        ? `Escrow sync complete — ${skipped} batch(es) skipped due to errors, some events may be missing`
        : 'Escrow sync complete',
    );
  }

  private reattachKnownEscrows(isAborted: AttachAbortFn): void {
    let reattached = 0;
    for (const { escrowAddr, registryAddr, tokenId } of this.knownEscrows.values()) {
      if (isAborted()) return;
      if (this.escrowListeners.has(escrowAddr.toLowerCase())) continue;
      this.attachEscrowListener(escrowAddr, registryAddr, tokenId, { logDiscovery: false });
      reattached++;
    }
    if (reattached > 0) {
      this.log.info(
        { chain: this.chainKey, reattached, total: this.knownEscrows.size },
        'Re-attached escrow listeners after reconnect',
      );
    }
  }

  private async queryFilterWithRetry(
    filterFn: () => ReturnType<Contract['filters'][string]>,
    batchFrom: number,
    batchTo: number,
    maxRetries = 6,
    maxBackoffMs = 32_000,
  ): Promise<Awaited<ReturnType<Contract['queryFilter']>> | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.contract.queryFilter(filterFn(), batchFrom, batchTo);
      } catch (err) {
        const is429 = isRateLimit(err);
        if (!is429 || attempt === maxRetries) {
          this.log.error({ chain: this.chainKey, batchFrom, batchTo, err }, 'Batch replay failed — skipping range');
          return null;
        }
        // Exponential backoff + jitter prevents thundering-herd on shared RPC endpoints.
        const jitterMs = Math.random() * 1000;
        const backoffMs = Math.min(Math.pow(2, attempt) * 1000 + jitterMs, maxBackoffMs);
        this.log.warn(
          { chain: this.chainKey, batchFrom, batchTo, attempt: attempt + 1, backoffMs: Math.round(backoffMs) },
          '429 rate limit — retrying after backoff',
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    return null;
  }

  private subscribeToNewEscrows(): void {
    this.contract.on(
      'TitleEscrowCreated',
      (escrowAddr: string, registryAddr: string, tokenId: bigint, payload: ContractEventPayload) => {
        if (!this.watchedRegistries.has(registryAddr.toLowerCase())) return;
        const norm = toNormalizedLog(payload.log);
        this.log.info(
          { chain: this.chainKey, escrow: escrowAddr, tokenId: tokenId.toString(), block: norm.blockNumber },
          'New escrow detected — attaching listener',
        );
        const event = normalizeFactoryEvent(escrowAddr, registryAddr, tokenId, norm, this.chainKey, this.chainId);
        this.emitter.emit(event).catch((err) => {
          this.log.error({ err, escrow: escrowAddr }, 'Failed to emit escrow_created event');
        });
        this.attachEscrowListener(escrowAddr, registryAddr, tokenId);
        if (getDb()) {
          void saveEscrow(this.chainKey, escrowAddr.toLowerCase(), registryAddr, tokenId.toString(), norm.blockNumber);
        }
      },
    );
  }

  private attachEscrowListener(
    escrowAddr: string,
    registryAddr: string,
    tokenId: bigint,
    opts?: { logDiscovery?: boolean },
  ): void {
    const key = escrowAddr.toLowerCase();
    if (this.escrowListeners.has(key)) return;
    this.knownEscrows.set(key, { escrowAddr, registryAddr, tokenId });
    const listener = new EscrowListener(
      escrowAddr,
      registryAddr,
      tokenId,
      this.chainKey,
      this.chainId,
      this.provider,
      this.emitter,
      this.log,
      this.confirmations,
      () => {
        this.escrowListeners.delete(key);
        this.knownEscrows.delete(key);
        if (getDb()) void markShredded(this.chainKey, key);
        this.log.info({ chain: this.chainKey, escrow: escrowAddr }, 'Escrow shredded — listener removed');
      },
    );
    try {
      listener.start();
    } catch (err) {
      if (isProviderDestroyed(err)) return;
      throw err;
    }
    this.escrowListeners.set(key, listener);
    if (opts?.logDiscovery !== false) {
      this.log.info(
        { chain: this.chainKey, escrow: escrowAddr, tokenId: tokenId.toString() },
        'Escrow discovered and listener attached',
      );
    }
  }

  async addWatchedRegistry(address: string, fromBlock: number): Promise<void> {
    const key = address.toLowerCase();
    if (this.watchedRegistries.has(key)) return;
    this.watchedRegistries.add(key);

    const filterFn = this.contract.filters['TitleEscrowCreated'];
    if (!filterFn) return;

    let currentBlock: number;
    try {
      currentBlock = await this.provider.getBlockNumber();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        { chain: this.chainKey, registry: address, err: msg },
        'Could not fetch block number for registry resync',
      );
      return;
    }

    this.log.info(
      { chain: this.chainKey, registry: address, from: fromBlock, to: currentBlock },
      'Resyncing new registry',
    );

    for (let batchFrom = fromBlock; batchFrom <= currentBlock; batchFrom += this.replayBatchSize) {
      const batchTo = Math.min(batchFrom + this.replayBatchSize - 1, currentBlock);
      const logs = await this.queryFilterWithRetry(filterFn, batchFrom, batchTo);
      if (logs === null) continue;
      for (const evLog of logs) {
        if (!isEventLog(evLog)) continue;
        const escrowAddr = evLog.args[0] as string;
        const registryAddr = evLog.args[1] as string;
        const tokenId = evLog.args[2] as bigint;
        if (registryAddr.toLowerCase() === key) {
          const isNew = !this.knownEscrows.has(escrowAddr.toLowerCase());
          this.attachEscrowListener(escrowAddr, registryAddr, tokenId);
          if (isNew && getDb()) {
            void saveEscrow(
              this.chainKey,
              escrowAddr.toLowerCase(),
              registryAddr,
              tokenId.toString(),
              evLog.blockNumber,
            );
          }
        }
      }
    }

    this.log.info({ chain: this.chainKey, registry: address }, 'Registry resync complete');
  }

  stop(): void {
    this.contract.removeAllListeners();
    for (const listener of this.escrowListeners.values()) {
      listener.stop();
    }
    this.escrowListeners.clear();
  }

  get activeEscrowCount(): number {
    return this.escrowListeners.size;
  }
}
