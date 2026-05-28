import type { NormalizedLog } from '../interfaces/cloud-event.js';

/**
 * Extracts the four fields every normalizer needs from an ethers EventLog or
 * plain Log. Centralised here so each listener does not repeat the same mapping.
 */
export function toNormalizedLog(evLog: {
  blockNumber: number;
  transactionHash: string;
  index: number;
  address: string;
}): NormalizedLog {
  return {
    blockNumber: evLog.blockNumber,
    transactionHash: evLog.transactionHash,
    logIndex: evLog.index,
    address: evLog.address,
  };
}
