import { Op } from 'sequelize';
import { ChainLease } from '../models/chain-lease.js';

export const LEASE_TTL_MS = parseInt(process.env['DB_LEASE_TTL_MS'] ?? '30000', 10);

/** Returns true if this instance now holds the lease for chainKey. */
export async function acquireLease(chainKey: string, holderId: string): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);

  // Fast path: insert (succeeds if no row exists yet).
  try {
    await ChainLease.create({ chainKey, holderId, acquiredAt: now, expiresAt, renewedAt: now });
    return true;
  } catch {
    // Row already exists — fall through to conditional UPDATE.
  }

  // Steal an expired lease or renew our own.
  const [count] = await ChainLease.update(
    { holderId, acquiredAt: now, expiresAt, renewedAt: now },
    {
      where: {
        chainKey,
        [Op.or]: [
          { expiresAt: { [Op.lt]: now } }, // expired — steal
          { holderId }, // already ours — renew
        ],
      },
    },
  );
  return count > 0;
}

/** Returns true if renewal succeeded (we still hold the lease). */
export async function renewLease(chainKey: string, holderId: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const [count] = await ChainLease.update({ expiresAt, renewedAt: new Date() }, { where: { chainKey, holderId } });
  return count > 0;
}

export async function releaseLease(chainKey: string, holderId: string): Promise<void> {
  await ChainLease.destroy({ where: { chainKey, holderId } });
}
