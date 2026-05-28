import { Sequelize } from 'sequelize';
import type { Logger } from 'pino';
import { initBlockProgress } from './models/block-progress.js';
import { initEscrow } from './models/escrow.js';
import { initChainLease } from './models/chain-lease.js';
import { initRegistryAddress } from './models/registry-address.js';

// ── Singleton ─────────────────────────────────────────────────────────────────

let _db: Sequelize | null = null;

export function getDb(): Sequelize | null {
  return _db;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function openDatabase(log: Logger): Promise<Sequelize | null> {
  const host = process.env['DB_HOST'];
  if (!host) {
    log.info('DB_HOST not set — running without persistent database');
    return null;
  }

  const dialect = (process.env['DB_DIALECT'] ?? 'postgres') as 'postgres' | 'mysql' | 'mariadb' | 'mssql';
  const defaultPorts: Record<string, string> = { postgres: '5432', mysql: '3306', mariadb: '3306', mssql: '1433' };
  const defaultPort = defaultPorts[dialect] ?? '5432';
  const port = parseInt(process.env['DB_PORT'] ?? defaultPort, 10);

  const seq = new Sequelize({
    dialect,
    host,
    port,
    database: process.env['DB_NAME'] ?? 'trustvc_events',
    username: process.env['DB_USER'] ?? 'trustvc',
    password: process.env['DB_PASSWORD'] ?? '',
    logging: false,
    pool: {
      max: parseInt(process.env['DB_POOL_MAX'] ?? '10', 10),
      min: parseInt(process.env['DB_POOL_MIN'] ?? '2', 10),
      acquire: parseInt(process.env['DB_POOL_ACQUIRE_MS'] ?? '30000', 10),
      idle: parseInt(process.env['DB_POOL_IDLE_MS'] ?? '10000', 10),
    },
  });

  initBlockProgress(seq);
  initEscrow(seq);
  initChainLease(seq);
  initRegistryAddress(seq);

  try {
    await seq.authenticate();
    // Creates tables that don't exist; leaves existing schema untouched.
    await seq.sync();
    _db = seq;
    log.info({ dialect, host, port, database: process.env['DB_NAME'] ?? 'trustvc_events' }, 'Database connected');
    return _db;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Database connection failed — running without persistent database');
    return null;
  }
}

export async function closeDatabase(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}
