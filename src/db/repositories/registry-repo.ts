import { RegistryAddress } from '../models/registry-address.js';

export interface PersistedRegistry {
  address: string;
  fromBlock: number;
}

export async function loadRegistries(chainKey: string): Promise<PersistedRegistry[]> {
  const rows = await RegistryAddress.findAll({ where: { chainKey, active: true } });
  return rows.map((r) => ({ address: r.address, fromBlock: r.fromBlock }));
}

export async function saveRegistry(chainKey: string, address: string, fromBlock: number): Promise<void> {
  await RegistryAddress.upsert({ chainKey, address, fromBlock, active: true });
}

export async function removeRegistry(chainKey: string, address: string): Promise<void> {
  await RegistryAddress.update({ active: false }, { where: { chainKey, address } });
}
