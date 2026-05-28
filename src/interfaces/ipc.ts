import type { ChainStatus } from '../chain-manager.js';
import type { CloudEvent } from './cloud-event.js';
import type { ChainConfig } from '../config/schema.js';

export type IpcChildMessage =
  | { type: 'ready'; status: ChainStatus }
  | { type: 'event'; payload: CloudEvent }
  | { type: 'status'; status: ChainStatus }
  | { type: 'error'; message: string }
  | { type: 'registryAdded'; address: string }
  | { type: 'registryRemoved'; address: string };

export type IpcParentMessage =
  | { type: 'init'; chainConfig: ChainConfig; chainDefKey: string; logLevel: string; stateDir: string }
  | { type: 'stop' }
  | { type: 'addRegistry'; address: string; fromBlock: number }
  | { type: 'removeRegistry'; address: string };
