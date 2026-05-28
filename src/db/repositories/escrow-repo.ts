import { Escrow } from '../models/escrow.js';

export interface PersistedEscrow {
  registryAddress: string;
  tokenId: string;
}

export async function loadEscrows(chainKey: string): Promise<Map<string, PersistedEscrow>> {
  const rows = await Escrow.findAll({ where: { chainKey, shredded: false } });
  const map = new Map<string, PersistedEscrow>();
  for (const row of rows) {
    map.set(row.address, { registryAddress: row.registryAddress, tokenId: row.tokenId });
  }
  return map;
}

export async function saveEscrow(
  chainKey: string,
  address: string,
  registryAddress: string,
  tokenId: string,
  discoveredBlock: number,
): Promise<void> {
  if (!registryAddress || !tokenId) return;
  await Escrow.findOrCreate({
    where: { chainKey, address },
    defaults: { chainKey, address, registryAddress, tokenId, discoveredBlock },
  });
}

export async function markShredded(chainKey: string, address: string): Promise<void> {
  await Escrow.update({ shredded: true }, { where: { chainKey, address } });
}
