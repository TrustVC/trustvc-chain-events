import type { NormalizedLog } from '../interfaces/cloud-event.js';

// Decodes an ethers v6 hex-encoded bytes value (e.g. "0x68656c6c6f") to a
// UTF-8 string. Strings without a 0x prefix are returned unchanged (allows
// plain-text values and test fixtures to pass through without corruption).
export function hexToUtf8(hex: string): string {
  if (!hex || !hex.startsWith('0x')) return hex ?? '';
  if (hex === '0x') return '';
  return Buffer.from(hex.slice(2), 'hex').toString('utf8');
}

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
