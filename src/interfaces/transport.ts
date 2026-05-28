import type { ProviderState } from '../rpc/provider-state.js';

export interface ITransport {
  start(): Promise<void>;
  stop(): void;
  getState(): ProviderState;
  activeEscrowCount: number;
  addRegistry(address: string, fromBlock: number): Promise<void>;
  removeRegistry(address: string): void;
}
