import { Contract, EventLog, Interface, JsonRpcProvider } from 'ethers';
import { isEventLog } from '../contracts/event-log.js';
import type { Logger } from 'pino';
import { REGISTRY_ABI, FACTORY_ABI, ESCROW_ABI } from '../contracts/abis.js';
import { resolveFactoryAddress } from '../contracts/factory-resolver.js';
import { BlockStateStore } from './block-state-store.js';
import {
  normalizeRegistryTransfer,
  normalizeRegistryPause,
  normalizeFactoryEvent,
  normalizeEscrowEvent,
} from '../delivery/event-normalizer.js';
import { initialProviderState, type ProviderState } from './provider-state.js';
import type { ITransport } from '../interfaces/transport.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { ChainConfig } from '../config/schema.js';
import type { ChainDef } from '../chains/catalog.js';
import { toNormalizedLog } from '../utils/eth.js';
import { isRateLimit } from './provider-errors.js';
import { meter } from '../telemetry/index.js';
import { getDb } from '../db/connection.js';
import { readBlock, writeBlock } from '../db/repositories/block-repo.js';
import { loadEscrows, saveEscrow, markShredded } from '../db/repositories/escrow-repo.js';
import { loadRegistries, saveRegistry } from '../db/repositories/registry-repo.js';

const eventsReceived = meter.createCounter('trustvc.chain.events_received', {
  description: 'On-chain ETR events detected per chain and event type',
});

interface EscrowInfo {
  registryAddr: string;
  tokenId: bigint;
}

// eth_getLogs accepts an address array — one call covers up to this many escrows.
const ESCROW_BATCH_SIZE = 100;

const ESCROW_EVENT_NAMES = new Set([
  'TokenReceived',
  'Nomination',
  'BeneficiaryTransfer',
  'HolderTransfer',
  'ReturnToIssuer',
  'Shred',
  'RejectTransferBeneficiary',
  'RejectTransferHolder',
  'RejectTransferOwners',
]);

export class HttpTransport implements ITransport {
  private readonly provider: JsonRpcProvider;
  private readonly pollIntervalMs: number;
  private readonly stateStore: BlockStateStore;
  private state: ProviderState;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // Contract instances created once in start() and reused across all polls.
  private factoryContract: Contract | null = null;
  private readonly registryContracts = new Map<string, Contract>();

  private readonly seenEscrows = new Map<string, EscrowInfo>();
  private readonly escrowIface = new Interface(ESCROW_ABI);
  // Lower-cased registry addresses — computed once, used in every factory log scan.
  private readonly watchedRegistries: Set<string>;

  constructor(
    private readonly chainConfig: ChainConfig,
    private readonly chainDef: ChainDef,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
    stateDir: string = './.state',
  ) {
    this.provider = new JsonRpcProvider(chainConfig.rpcUrl);
    this.pollIntervalMs = chainConfig.pollIntervalMs ?? chainDef.pollIntervalMs;
    this.stateStore = new BlockStateStore(stateDir, chainDef.key);
    this.state = initialProviderState();
    this.watchedRegistries = new Set(chainConfig.registryAddresses.map((a) => a.toLowerCase()));
  }

  // ── Startup ──────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    try {
      const factoryAddress = await resolveFactoryAddress(this.chainConfig.registryAddresses, this.provider);
      this.factoryContract = new Contract(factoryAddress, FACTORY_ABI, this.provider);
      for (const addr of this.chainConfig.registryAddresses) {
        this.registryContracts.set(addr.toLowerCase(), new Contract(addr, REGISTRY_ABI, this.provider));
      }

      const currentBlock = await this.provider.getBlockNumber();

      // ── Phase 1: restore from DB (0 RPC calls) ──────────────────────────
      let indexFrom: number;
      const db = getDb();
      if (db) {
        const persisted = await loadEscrows(this.chainDef.key);
        for (const [addr, info] of persisted) {
          this.seenEscrows.set(addr, { registryAddr: info.registryAddress, tokenId: BigInt(info.tokenId) });
        }
        this.log.info({ chain: this.chainDef.key, count: persisted.size }, 'HTTP: escrows restored from DB');
        const lastBlock = await readBlock(this.chainDef.key);
        indexFrom = lastBlock !== null ? lastBlock + 1 : (this.chainConfig.replayFromBlock ?? 0);
        const dbRegistries = await loadRegistries(this.chainDef.key);
        for (const r of dbRegistries) {
          const addr = r.address.toLowerCase();
          if (!this.watchedRegistries.has(addr)) {
            this.watchedRegistries.add(addr);
            this.registryContracts.set(addr, new Contract(r.address, REGISTRY_ABI, this.provider));
          }
        }
      } else {
        const persistedBlock = await this.stateStore.read();
        indexFrom = persistedBlock !== null ? persistedBlock + 1 : (this.chainConfig.replayFromBlock ?? 0);
      }

      // ── Phase 2: delta scan for new escrows (minimal RPC calls) ─────────
      if (indexFrom <= currentBlock) {
        const batchCount = Math.ceil((currentBlock - indexFrom + 1) / this.chainConfig.replayBatchSize);
        this.log.info(
          { chain: this.chainDef.key, from: indexFrom, to: currentBlock, batches: batchCount },
          'HTTP: building escrow index',
        );
        await this.buildEscrowIndex(indexFrom, currentBlock);
        this.log.info(
          { chain: this.chainDef.key, escrows: this.seenEscrows.size },
          'HTTP: escrow index ready — starting poll',
        );
      }

      // ── Phase 3: begin poll ───────────────────────────────────────────────
      this.state.lastSeenBlock = currentBlock;
      await this.stateStore.write(currentBlock);
      if (db) void writeBlock(this.chainDef.key, currentBlock);
      this.state.status = 'connected';
      this.state.lastConnectedAt = new Date();
      this.log.info(
        { chain: this.chainDef.key, block: currentBlock, knownEscrows: this.seenEscrows.size },
        'HTTP transport connected',
      );
      this.schedulePoll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.status = 'failed';
      this.state.lastError = msg;
      this.log.error({ chain: this.chainDef.key, err: msg }, 'HTTP transport failed to start');
    }
  }

  // Scans TitleEscrowCreated logs from [from] to [to] in batches, populating
  // seenEscrows without emitting any webhooks. Each batch is one RPC call.
  // Delay between batches = replayDelayMs / 5 (1 req vs 5 in a full poll batch).
  private async buildEscrowIndex(from: number, to: number): Promise<void> {
    const batchSize = this.chainConfig.replayBatchSize;
    const delayMs = Math.max(Math.floor(this.chainConfig.replayDelayMs / 5), 500);
    let first = true;
    for (let start = from; start <= to; start += batchSize) {
      if (this.destroyed) return;
      if (!first && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      first = false;
      const end = Math.min(start + batchSize - 1, to);
      try {
        await this.scanFactoryRange(start, end, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ chain: this.chainDef.key, start, end, err: msg }, 'Index batch failed — skipping range');
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  stop(): void {
    this.destroyed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getState(): ProviderState {
    return this.state;
  }

  get activeEscrowCount(): number {
    return this.seenEscrows.size;
  }

  async addRegistry(address: string, fromBlock: number): Promise<void> {
    const key = address.toLowerCase();
    if (this.watchedRegistries.has(key)) return;
    this.watchedRegistries.add(key);
    this.registryContracts.set(key, new Contract(address, REGISTRY_ABI, this.provider));
    if (getDb()) void saveRegistry(this.chainDef.key, key, fromBlock);
    const currentBlock = await this.provider.getBlockNumber();
    if (fromBlock <= currentBlock) {
      this.log.info(
        { chain: this.chainDef.key, registry: address, from: fromBlock, to: currentBlock },
        'HTTP: resyncing new registry',
      );
      await this.buildEscrowIndex(fromBlock, currentBlock);
      this.log.info({ chain: this.chainDef.key, registry: address }, 'HTTP: registry resync complete');
    }
  }

  removeRegistry(address: string): void {
    const key = address.toLowerCase();
    this.watchedRegistries.delete(key);
    this.registryContracts.delete(key);
    // Drop all in-memory escrows belonging to this registry so they are no longer polled.
    for (const [escrowKey, info] of this.seenEscrows) {
      if (info.registryAddr.toLowerCase() === key) {
        this.seenEscrows.delete(escrowKey);
      }
    }
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (this.destroyed) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const latest = await this.provider.getBlockNumber();
      const from = (this.state.lastSeenBlock ?? latest - 1) + 1;
      if (from <= latest) {
        await this.processNewBlocks(from, latest);
        this.state.lastSeenBlock = latest;
        await this.stateStore.write(latest);
        const db = getDb();
        if (db) void writeBlock(this.chainDef.key, latest);
      }
      this.state.status = 'connected';
      this.state.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ chain: this.chainDef.key, err: msg }, 'Poll cycle failed — will retry same block range');
      this.state.lastError = msg;
      this.state.status = 'reconnecting';
    }
    this.schedulePoll();
  }

  // ── Block processing ──────────────────────────────────────────────────────────

  // Processes all events in [from, to]: registry, factory (discovers new escrows),
  // then escrow events on all currently known escrows.
  // Called once per poll tick — typically covers only a handful of new blocks.
  private async processNewBlocks(from: number, to: number): Promise<void> {
    // All registries and factory scan run in parallel; escrow logs follow after
    // so newly-discovered escrows from scanFactoryRange are included.
    await Promise.all([
      ...[...this.registryContracts.values()].map((c) => this.processRegistryLogs(c, from, to)),
      this.scanFactoryRange(from, to, false),
    ]);
    await this.processEscrowLogs(from, to);
  }

  private async processRegistryLogs(contract: Contract, fromBlock: number, toBlock: number): Promise<void> {
    const transferFn = contract.filters['Transfer'];
    const pauseFn = contract.filters['PauseWithRemark'];
    const unpauseFn = contract.filters['UnpauseWithRemark'];
    if (!transferFn || !pauseFn || !unpauseFn) return;

    // Fetch all three event types in parallel — one eth_getLogs per filter.
    const [transferLogs, pauseLogs, unpauseLogs] = await Promise.all([
      this.queryFilterWithRetry(contract, transferFn, fromBlock, toBlock),
      this.queryFilterWithRetry(contract, pauseFn, fromBlock, toBlock),
      this.queryFilterWithRetry(contract, unpauseFn, fromBlock, toBlock),
    ]);

    // Merge and sort by block/logIndex so downstream ordering is deterministic.
    const allLogs = [...(transferLogs ?? []), ...(pauseLogs ?? []), ...(unpauseLogs ?? [])];
    allLogs.sort((a, b) => a.blockNumber - b.blockNumber || (a as EventLog).index - (b as EventLog).index);

    for (const evLog of allLogs) {
      if (!isEventLog(evLog)) continue;
      await this.processRegistryLog(evLog);
    }
  }

  private async processRegistryLog(evLog: EventLog): Promise<void> {
    const norm = toNormalizedLog(evLog);
    if (evLog.eventName === 'Transfer') {
      const from = evLog.args[0] as string;
      const to = evLog.args[1] as string;
      const tokenId = evLog.args[2] as bigint;
      const event = normalizeRegistryTransfer({ from, to, tokenId }, norm, this.chainDef.key, this.chainDef.chainId);
      if (event) {
        eventsReceived.add(1, { chain: this.chainDef.key, event_type: evLog.eventName });
        await this.emitter.emit(event);
      }
    } else if (evLog.eventName === 'PauseWithRemark' || evLog.eventName === 'UnpauseWithRemark') {
      const remark = evLog.args[0] as string;
      const event = normalizeRegistryPause(evLog.eventName, remark, norm, this.chainDef.key, this.chainDef.chainId);
      eventsReceived.add(1, { chain: this.chainDef.key, event_type: evLog.eventName });
      await this.emitter.emit(event);
    }
  }

  // Scans TitleEscrowCreated in [from, to].
  // silent=true: only update seenEscrows, no webhooks (used during index build).
  // silent=false: also emit escrow_created webhook for each new escrow.
  private async scanFactoryRange(fromBlock: number, toBlock: number, silent: boolean): Promise<void> {
    if (!this.factoryContract) return;
    const filterFn = this.factoryContract.filters['TitleEscrowCreated'];
    if (!filterFn) return;

    const logs = await this.queryFilterWithRetry(this.factoryContract!, filterFn, fromBlock, toBlock);
    if (!logs) return;

    for (const evLog of logs) {
      if (!isEventLog(evLog)) continue;
      const escrowAddr = evLog.args[0] as string;
      const registryAddr = evLog.args[1] as string;
      const tokenId = evLog.args[2] as bigint;
      if (!this.watchedRegistries.has(registryAddr.toLowerCase())) continue;

      const key = escrowAddr.toLowerCase();
      if (!this.seenEscrows.has(key)) {
        this.seenEscrows.set(key, { registryAddr: registryAddr.toLowerCase(), tokenId });
        this.log.debug(
          { chain: this.chainDef.key, escrow: escrowAddr, tokenId: tokenId.toString() },
          'HTTP: new escrow discovered',
        );
        const db = getDb();
        if (db)
          void saveEscrow(
            this.chainDef.key,
            key,
            registryAddr.toLowerCase(),
            tokenId.toString(),
            evLog.blockNumber as number,
          );
      }

      if (!silent) {
        const event = normalizeFactoryEvent(
          escrowAddr,
          registryAddr,
          tokenId,
          toNormalizedLog(evLog),
          this.chainDef.key,
          this.chainDef.chainId,
        );
        eventsReceived.add(1, { chain: this.chainDef.key, event_type: 'TitleEscrowCreated' });
        await this.emitter.emit(event);
      }
    }
  }

  // Queries events on all known escrows in [from, to].
  // Escrows are batched into groups of ESCROW_BATCH_SIZE for fewer RPC calls.
  // Processed sequentially to avoid bursting through rate limits.
  private async processEscrowLogs(fromBlock: number, toBlock: number): Promise<void> {
    const escrows = [...this.seenEscrows.entries()];
    if (escrows.length === 0) return;

    for (let i = 0; i < escrows.length; i += ESCROW_BATCH_SIZE) {
      const batch = escrows.slice(i, i + ESCROW_BATCH_SIZE);
      await this.processEscrowBatch(batch, fromBlock, toBlock);
    }
  }

  private async processEscrowBatch(batch: [string, EscrowInfo][], fromBlock: number, toBlock: number): Promise<void> {
    const addresses = batch.map(([addr]) => addr);
    let rawLogs;
    try {
      rawLogs = await this.getLogsWithRetry(addresses, fromBlock, toBlock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { chain: this.chainDef.key, batchSize: addresses.length, err: msg },
        'Failed to fetch escrow batch logs — skipping',
      );
      return;
    }

    const infoByAddr = new Map(batch);
    for (const rawLog of rawLogs) {
      const info = infoByAddr.get(rawLog.address.toLowerCase());
      if (!info) continue;
      let parsed;
      try {
        parsed = this.escrowIface.parseLog(rawLog);
      } catch {
        continue;
      }
      if (!parsed || !ESCROW_EVENT_NAMES.has(parsed.name)) continue;

      const namedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.args.toObject())) {
        namedArgs[k] = typeof v === 'bigint' ? v.toString() : v;
      }
      const event = normalizeEscrowEvent(
        parsed.name,
        namedArgs,
        info.tokenId,
        info.registryAddr,
        toNormalizedLog(rawLog),
        this.chainDef.key,
        this.chainDef.chainId,
      );
      if (event) {
        eventsReceived.add(1, { chain: this.chainDef.key, event_type: parsed.name });
        await this.emitter.emit(event);
        if (parsed.name === 'Shred') {
          this.seenEscrows.delete(rawLog.address.toLowerCase());
          const db = getDb();
          if (db) void markShredded(this.chainDef.key, rawLog.address.toLowerCase());
        }
      }
    }
  }

  // ── RPC helpers ───────────────────────────────────────────────────────────────

  // Retries queryFilter on 429s with exponential backoff; returns null on
  // non-recoverable errors so callers skip the range instead of crashing.
  private async queryFilterWithRetry(
    contract: Contract,
    filterFn: Contract['filters'][string],
    fromBlock: number,
    toBlock: number,
    maxRetries = 4,
  ): Promise<Awaited<ReturnType<Contract['queryFilter']>> | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await contract.queryFilter(filterFn(), fromBlock, toBlock);
      } catch (err) {
        if (!isRateLimit(err) || attempt === maxRetries) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(
            { chain: this.chainDef.key, fromBlock, toBlock, err: msg },
            'queryFilter failed — skipping range',
          );
          return null;
        }
        const backoffMs = Math.min(Math.pow(2, attempt) * 2_000, 30_000);
        this.log.warn({ chain: this.chainDef.key, attempt: attempt + 1, backoffMs }, '429 — backing off');
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    return null;
  }

  // Retries getLogs on 429s with exponential backoff; throws on other errors.
  private async getLogsWithRetry(
    addresses: string[],
    fromBlock: number,
    toBlock: number,
    maxRetries = 4,
  ): Promise<Awaited<ReturnType<JsonRpcProvider['getLogs']>>> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.provider.getLogs({ address: addresses, fromBlock, toBlock });
      } catch (err) {
        if (!isRateLimit(err) || attempt === maxRetries) throw err;
        const backoffMs = Math.min(Math.pow(2, attempt) * 2_000, 30_000);
        this.log.warn({ chain: this.chainDef.key, attempt: attempt + 1, backoffMs }, '429 on getLogs — backing off');
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw new Error('unreachable');
  }
}
