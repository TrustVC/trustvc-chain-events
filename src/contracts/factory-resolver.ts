import { Contract } from 'ethers';
import type { ContractRunner } from 'ethers';
import { REGISTRY_ABI } from './abis.js';

/**
 * Resolves the escrow factory address by calling `titleEscrowFactory()` on the
 * first registry contract. All registries on a chain share the same factory.
 */
export async function resolveFactoryAddress(registryAddresses: string[], runner: ContractRunner): Promise<string> {
  const registryAddress = registryAddresses[0];
  if (!registryAddress) throw new Error('No registry addresses configured — cannot resolve factory address');

  const registry = new Contract(registryAddress, REGISTRY_ABI, runner);
  const factory = (await registry.titleEscrowFactory()) as string;
  if (!factory || factory === '0x0000000000000000000000000000000000000000') {
    throw new Error(`Registry at ${registryAddress} returned zero address for titleEscrowFactory()`);
  }
  return factory;
}
