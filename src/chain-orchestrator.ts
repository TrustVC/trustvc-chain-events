import { fork, type ChildProcess } from 'node:child_process';
import { hostname } from 'node:os';
import { isAddress, JsonRpcProvider, WebSocketProvider } from 'ethers';
import type { Logger } from 'pino';
import { getDb } from './db/connection.js';
import { acquireLease, renewLease, releaseLease, LEASE_TTL_MS } from './db/repositories/lease-repo.js';
import { saveRegistry } from './db/repositories/registry-repo.js';
import { resolveFactoryAddress } from './contracts/factory-resolver.js';
import { ChainManager, type ChainStatus } from './chain-manager.js';
import { CHAIN_CATALOG_BY_KEY } from './chains/catalog.js';
import type { IWebhookEmitter } from './interfaces/emitter.js';
import type { IpcChildMessage, IpcParentMessage } from './interfaces/ipc.js';
import type { AppConfig, ChainConfig } from './config/schema.js';
import type { ChainDef } from './chains/catalog.js';

// Delay before restarting a crashed worker — prevents tight restart loops.
const WORKER_RESTART_DELAY_MS = 5_000;
// Time given to a worker to exit cleanly before it receives SIGKILL.
const WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

// URL.pathname avoids importing fileURLToPath, which collides with the esbuild
// banner that already declares it at the bundle top-level.
// Safe on Linux/macOS/Docker; not suitable for Windows paths.
function resolveWorkerPath(): string {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`workers/chain-worker${ext}`, import.meta.url).pathname;
}

// Resolves to src/telemetry/instrumentation.ts in dev (tsx) or dist/telemetry/instrumentation.js in prod.
// Loaded via --import in each worker so OTel context is available in child processes.
function resolveInstrumentationPath(): string {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`telemetry/instrumentation${ext}`, import.meta.url).pathname;
}

interface ChainProcess {
  proc: ChildProcess;
  status: ChainStatus;
  chainConfig: ChainConfig;
  chainDef: ChainDef;
}

export class ChainOrchestrator {
  // In-process managers (used when workerProcesses=false)
  private managers: ChainManager[] = [];
  // Per-chain child processes (used when workerProcesses=true)
  private chainProcesses = new Map<string, ChainProcess>();

  // Pending addRegistry acks: address → list of resolve callbacks waiting for worker confirmation.
  private readonly pendingRegistryAdds = new Map<string, Array<() => void>>();
  // Pending removeRegistry acks: address → list of resolve callbacks.
  private readonly pendingRegistryRemoves = new Map<string, Array<() => void>>();

  // Distributed lease state (active only when DB_HOST is set)
  private readonly holderId = `${hostname()}-${process.pid}`;
  private readonly heldLeases = new Set<string>();
  private readonly failedChains = new Set<string>(); // chains permanently failed on this replica — don't retry
  private leaseRenewalTimer: ReturnType<typeof setInterval> | null = null;
  // Cached worker path so the lease watcher can spawn workers on failover.
  private workerPath: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.syncConfigRegistries();
    if (this.config.server.workerProcesses) {
      await this.startWithWorkers();
    } else {
      await this.startInProcess();
    }
  }

  // Persists config.json registry addresses to DB on startup so they appear
  // in GET /registries and are available to standby replicas via DB load.
  private async syncConfigRegistries(): Promise<void> {
    if (!getDb()) return;
    for (const chainConfig of this.config.chains) {
      for (const addr of chainConfig.registryAddresses) {
        await saveRegistry(chainConfig.chainKey, addr.toLowerCase(), chainConfig.replayFromBlock ?? 0);
      }
    }
  }

  // ── In-process (original behaviour) ─────────────────────────────────────────

  private async startInProcess(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const chainConfig of this.config.chains) {
      const chainDef = CHAIN_CATALOG_BY_KEY.get(chainConfig.chainKey);
      if (!chainDef) {
        this.log.error({ chainKey: chainConfig.chainKey }, 'Unknown chain key — skipping');
        continue;
      }
      // Acquire distributed lease before starting (no-op when DB_HOST is not set)
      if (getDb()) {
        const acquired = await acquireLease(chainDef.key, this.holderId);
        if (!acquired) {
          this.log.info({ chain: chainDef.key }, 'Chain lease held by another instance — standing by');
          continue;
        }
        this.heldLeases.add(chainDef.key);
      }
      const manager = new ChainManager(chainConfig, chainDef, this.emitter, this.log, this.config.stateDir);
      this.managers.push(manager);
      tasks.push(manager.start());
    }
    const results = await Promise.allSettled(tasks);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        this.log.error({ chain: this.managers[i]?.chainKey, err: msg }, 'Chain failed to start');
      }
    });
    this.startLeaseRenewal();
  }

  private startLeaseRenewal(): void {
    if (!getDb()) return;
    if (this.leaseRenewalTimer) return;
    const interval = Math.floor(LEASE_TTL_MS / 2);
    this.leaseRenewalTimer = setInterval(() => {
      void this.tickLeases();
    }, interval);
  }

  private isChainFailed(chainKey: string): boolean {
    if (this.config.server.workerProcesses) {
      return this.chainProcesses.get(chainKey)?.status.providerState.status === 'failed';
    }
    return this.managers.find((m) => m.chainKey === chainKey)?.getStatus().providerState.status === 'failed';
  }

  private async tickLeases(): Promise<void> {
    // 1. Renew leases we hold; stop the chain immediately if we lost one.
    //    If the chain is permanently failed, release the lease so another replica
    //    can take over — prevents a dead chain from holding its lease indefinitely.
    for (const chainKey of [...this.heldLeases]) {
      const isFailed = this.isChainFailed(chainKey);
      if (isFailed) {
        this.log.warn({ chain: chainKey }, 'Chain permanently failed — releasing lease for failover');
        this.failedChains.add(chainKey);
        this.heldLeases.delete(chainKey);
        void releaseLease(chainKey, this.holderId);
        const idx = this.managers.findIndex((m) => m.chainKey === chainKey);
        if (idx >= 0) {
          this.managers[idx].stop();
          this.managers.splice(idx, 1);
        }
        const cp = this.chainProcesses.get(chainKey);
        if (cp) {
          this.chainProcesses.delete(chainKey);
          cp.proc.send({ type: 'stop' } as IpcParentMessage);
        }
        continue;
      }

      const stillHeld = await renewLease(chainKey, this.holderId);
      if (!stillHeld) {
        this.log.warn({ chain: chainKey }, 'Lease lost to another instance — stopping chain');
        this.heldLeases.delete(chainKey);
        // In-process mode
        const idx = this.managers.findIndex((m) => m.chainKey === chainKey);
        if (idx >= 0) {
          this.managers[idx].stop();
          this.managers.splice(idx, 1);
        }
        // Worker-process mode — delete first so the exit handler won't restart it
        const cp = this.chainProcesses.get(chainKey);
        if (cp) {
          this.chainProcesses.delete(chainKey);
          cp.proc.send({ type: 'stop' } as IpcParentMessage);
        }
      }
    }

    // 2. Try to acquire leases for chains this instance isn't running yet.
    //    Covers two scenarios: initial standby replicas and failover after crash.
    for (const chainConfig of this.config.chains) {
      const chainDef = CHAIN_CATALOG_BY_KEY.get(chainConfig.chainKey);
      if (!chainDef || this.heldLeases.has(chainDef.key) || this.failedChains.has(chainDef.key)) continue;

      const acquired = await acquireLease(chainDef.key, this.holderId);
      if (!acquired) continue;

      this.heldLeases.add(chainDef.key);
      this.log.info({ chain: chainDef.key }, 'Standby lease acquired — starting chain');

      if (this.config.server.workerProcesses && this.workerPath) {
        void this.spawnChain(chainConfig, chainDef, this.workerPath);
      } else {
        const manager = new ChainManager(chainConfig, chainDef, this.emitter, this.log, this.config.stateDir);
        this.managers.push(manager);
        void manager.start().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error({ chain: chainDef.key, err: msg }, 'Chain failed to start after standby lease acquisition');
        });
      }
    }
  }

  // ── Child-process mode ───────────────────────────────────────────────────────

  private async startWithWorkers(): Promise<void> {
    this.workerPath = resolveWorkerPath();
    const workerPath = this.workerPath;
    this.log.info({ workerPath }, 'Starting chains as child processes');

    const tasks: Promise<void>[] = [];
    for (const chainConfig of this.config.chains) {
      const chainDef = CHAIN_CATALOG_BY_KEY.get(chainConfig.chainKey);
      if (!chainDef) {
        this.log.error({ chainKey: chainConfig.chainKey }, 'Unknown chain key — skipping');
        continue;
      }
      // Parent acquires the distributed lease before spawning — workers open their own DB connection.
      if (getDb()) {
        const acquired = await acquireLease(chainDef.key, this.holderId);
        if (!acquired) {
          this.log.info({ chain: chainDef.key }, 'Chain lease held by another instance — standing by');
          continue;
        }
        this.heldLeases.add(chainDef.key);
      }
      tasks.push(this.spawnChain(chainConfig, chainDef, workerPath));
    }
    await Promise.allSettled(tasks);
    this.startLeaseRenewal();
  }

  private spawnChain(chainConfig: ChainConfig, chainDef: ChainDef, workerPath: string): Promise<void> {
    return new Promise((resolve) => {
      const isTs = workerPath.endsWith('.ts');
      const child = fork(workerPath, [], {
        execArgv: [
          ...(isTs ? ['--import', 'tsx/esm'] : []),
          // Load OTel bootstrap in each worker so child processes emit their own spans/metrics.
          '--import',
          resolveInstrumentationPath(),
        ],
        serialization: 'json',
      });

      const entry: ChainProcess = {
        proc: child,
        chainConfig,
        chainDef,
        status: {
          chainKey: chainDef.key,
          chainId: chainDef.chainId,
          transport: chainDef.transport,
          providerState: {
            status: 'connecting',
            reconnectAttempts: 0,
            lastError: null,
            lastErrorAt: null,
            lastConnectedAt: null,
            lastSeenBlock: null,
          },
          activeEscrows: 0,
        },
      };
      this.chainProcesses.set(chainDef.key, entry);

      // Send init payload
      const initMsg: IpcParentMessage = {
        type: 'init',
        chainConfig,
        chainDefKey: chainDef.key,
        logLevel: this.config.logLevel,
        stateDir: this.config.stateDir,
      };
      child.send(initMsg);

      child.on('message', (raw: unknown) => {
        const msg = raw as IpcChildMessage;
        if (msg.type === 'ready') {
          entry.status = msg.status;
          this.log.info({ chain: chainDef.key, escrows: msg.status.activeEscrows }, 'Chain worker ready');
          resolve();
        } else if (msg.type === 'event') {
          this.emitter.emit(msg.payload).catch((err: unknown) => {
            const m = err instanceof Error ? err.message : String(err);
            this.log.error({ chain: chainDef.key, err: m }, 'Failed to emit event from worker');
          });
        } else if (msg.type === 'status') {
          entry.status = msg.status;
        } else if (msg.type === 'error') {
          this.log.error({ chain: chainDef.key, err: msg.message }, 'Chain worker startup error');
          resolve(); // resolve so allSettled doesn't hang; worker may auto-restart
        } else if (msg.type === 'registryAdded') {
          const resolvers = this.pendingRegistryAdds.get(msg.address);
          if (resolvers?.length) {
            this.pendingRegistryAdds.delete(msg.address);
            for (const fn of resolvers) fn();
          }
        } else if (msg.type === 'registryRemoved') {
          const resolvers = this.pendingRegistryRemoves.get(msg.address);
          if (resolvers?.length) {
            this.pendingRegistryRemoves.delete(msg.address);
            for (const fn of resolvers) fn();
          }
        }
      });

      child.on('exit', (code) => {
        this.log.warn(
          { chain: chainDef.key, code },
          `Chain worker exited — restarting in ${WORKER_RESTART_DELAY_MS / 1_000} s`,
        );
        setTimeout(() => {
          if (this.chainProcesses.has(chainDef.key)) {
            void this.spawnChain(chainConfig, chainDef, workerPath);
          }
        }, WORKER_RESTART_DELAY_MS);
      });

      child.on('error', (err) => {
        this.log.error({ chain: chainDef.key, err: err.message }, 'Chain worker process error');
        resolve();
      });
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  stop(): void {
    if (this.leaseRenewalTimer) {
      clearInterval(this.leaseRenewalTimer);
      this.leaseRenewalTimer = null;
    }
    for (const chainKey of this.heldLeases) void releaseLease(chainKey, this.holderId);
    this.heldLeases.clear();

    for (const m of this.managers) m.stop();
    this.managers = [];

    const stopMsg: IpcParentMessage = { type: 'stop' };
    for (const [key, { proc }] of this.chainProcesses) {
      proc.send(stopMsg);
      this.chainProcesses.delete(key);
    }
  }

  /** Like stop(), but awaits each child worker's exit (SIGKILL after 10 s). */
  async stopAsync(): Promise<void> {
    if (this.leaseRenewalTimer) {
      clearInterval(this.leaseRenewalTimer);
      this.leaseRenewalTimer = null;
    }
    await Promise.all([...this.heldLeases].map((k) => releaseLease(k, this.holderId)));
    this.heldLeases.clear();

    for (const m of this.managers) m.stop();
    this.managers = [];

    if (this.chainProcesses.size === 0) return;

    const entries = [...this.chainProcesses.entries()];

    // Clear the map BEFORE sending stop so the 'exit' event handler cannot
    // schedule a restart for a worker that is intentionally shutting down.
    this.chainProcesses.clear();

    const exitPromises = entries.map(([key, { proc }]) => {
      const p = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.log.warn({ chain: key }, 'Worker did not exit in time — sending SIGKILL');
          proc.kill('SIGKILL');
          resolve();
        }, WORKER_SHUTDOWN_TIMEOUT_MS);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      proc.send({ type: 'stop' } as IpcParentMessage);
      return p;
    });

    await Promise.all(exitPromises);
  }

  async addRegistry(chainKey: string, address: string, fromBlock: number): Promise<void> {
    if (this.config.server.workerProcesses) {
      const cp = this.chainProcesses.get(chainKey);
      if (!cp) {
        this.log.warn({ chain: chainKey }, 'addRegistry: no active worker for chain');
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.log.warn({ chain: chainKey, address }, 'addRegistry: worker ack timed out after 30 s — continuing');
            resolve();
          }
        }, 30_000);
        const existing = this.pendingRegistryAdds.get(address) ?? [];
        existing.push(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        this.pendingRegistryAdds.set(address, existing);
        cp.proc.send({ type: 'addRegistry', address, fromBlock } as IpcParentMessage);
      });
    } else {
      const manager = this.managers.find((m) => m.chainKey === chainKey);
      if (!manager) {
        this.log.warn({ chain: chainKey }, 'addRegistry: no active manager for chain');
        return;
      }
      await manager.addRegistry(address, fromBlock);
    }
  }

  removeRegistry(chainKey: string, address: string): Promise<void> {
    if (this.config.server.workerProcesses) {
      const cp = this.chainProcesses.get(chainKey);
      if (!cp) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.log.warn({ chain: chainKey, address }, 'removeRegistry: worker ack timed out after 10 s');
            resolve();
          }
        }, 10_000);
        const existing = this.pendingRegistryRemoves.get(address) ?? [];
        existing.push(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        this.pendingRegistryRemoves.set(address, existing);
        cp.proc.send({ type: 'removeRegistry', address } as IpcParentMessage);
      });
    }
    const manager = this.managers.find((m) => m.chainKey === chainKey);
    manager?.removeRegistry(address);
    return Promise.resolve();
  }

  // Validates address format then calls titleEscrowFactory() on-chain to confirm
  // the address is a deployed TrustVC registry. Throws if either check fails.
  async verifyRegistry(chainKey: string, address: string): Promise<void> {
    if (!isAddress(address)) {
      throw Object.assign(new Error(`Invalid EVM address: ${address}`), { statusCode: 400 });
    }
    const chainConfig = this.config.chains.find((c) => c.chainKey === chainKey);
    if (!chainConfig) {
      throw Object.assign(new Error(`Chain ${chainKey} is not in your config — add it first`), { statusCode: 400 });
    }
    const url = chainConfig.rpcUrl;
    const isWs = url.startsWith('ws://') || url.startsWith('wss://');
    const provider = isWs ? new WebSocketProvider(url) : new JsonRpcProvider(url);
    try {
      await resolveFactoryAddress([address], provider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Object.assign(new Error(`${address} is not a valid TrustVC registry on ${chainKey}: ${msg}`), {
        statusCode: 422,
      });
    } finally {
      provider.destroy();
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  getChainStatuses(): ChainStatus[] {
    if (this.config.server.workerProcesses) {
      return [...this.chainProcesses.values()].map((cp) => cp.status);
    }
    return this.managers.map((m) => m.getStatus());
  }

  get chainCount(): number {
    return this.config.server.workerProcesses ? this.chainProcesses.size : this.managers.length;
  }

  /** Number of alive child processes (0 when workerProcesses=false). */
  get activeWorkerCount(): number {
    return this.config.server.workerProcesses ? this.chainProcesses.size : 0;
  }

  get totalActiveEscrows(): number {
    if (this.config.server.workerProcesses) {
      return [...this.chainProcesses.values()].reduce((s, cp) => s + cp.status.activeEscrows, 0);
    }
    return this.managers.reduce((s, m) => s + m.getStatus().activeEscrows, 0);
  }
}
