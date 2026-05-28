import { v4 as uuidv4 } from 'uuid';
import type { CloudEvent, NormalizedLog } from '../interfaces/cloud-event.js';

const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function toCloudEvent(
  eventType: string,
  chainKey: string,
  chainId: number,
  registryAddress: string,
  tokenId: bigint,
  norm: NormalizedLog,
  payload: Record<string, unknown>,
): CloudEvent {
  const data = {
    chainKey,
    chainId,
    registryAddress: registryAddress.toLowerCase(),
    tokenId: tokenId.toString(),
    blockNumber: norm.blockNumber,
    transactionHash: norm.transactionHash,
    logIndex: norm.logIndex,
    idempotencyKey: `${chainId}-${norm.transactionHash}-${norm.logIndex}`,
    payload,
  };
  return {
    specversion: '1.0',
    id: uuidv4(),
    source: `urn:trustvc:${chainId}:${registryAddress.toLowerCase()}`,
    type: `com.trustvc.${eventType}`,
    datacontenttype: 'application/json',
    time: new Date().toISOString(),
    subject: tokenId.toString(),
    data,
  };
}

export function normalizeRegistryTransfer(
  raw: { from: string; to: string; tokenId: bigint },
  norm: NormalizedLog,
  chainKey: string,
  chainId: number,
): CloudEvent | null {
  const from = raw.from.toLowerCase();
  const to = raw.to.toLowerCase();
  const registryAddress = norm.address.toLowerCase();

  const tokenId = raw.tokenId.toString();
  if (from === ZERO_ADDRESS.toLowerCase()) {
    return toCloudEvent('etr.minted', chainKey, chainId, registryAddress, raw.tokenId, norm, { to, tokenId });
  }
  if (to === BURN_ADDRESS.toLowerCase()) {
    return toCloudEvent('etr.burned', chainKey, chainId, registryAddress, raw.tokenId, norm, { from, tokenId });
  }
  if (to === registryAddress) {
    return toCloudEvent('etr.surrendered', chainKey, chainId, registryAddress, raw.tokenId, norm, { from, tokenId });
  }
  if (from === registryAddress) {
    return toCloudEvent('etr.restored', chainKey, chainId, registryAddress, raw.tokenId, norm, { to, tokenId });
  }
  return null;
}

export function normalizeRegistryPause(
  eventName: 'PauseWithRemark' | 'UnpauseWithRemark',
  account: string,
  remark: string,
  norm: NormalizedLog,
  chainKey: string,
  chainId: number,
): CloudEvent {
  const eventType = eventName === 'PauseWithRemark' ? 'etr.registry_paused' : 'etr.registry_unpaused';
  return {
    specversion: '1.0',
    id: uuidv4(),
    source: `urn:trustvc:${chainId}:${norm.address.toLowerCase()}`,
    type: `com.trustvc.${eventType}`,
    datacontenttype: 'application/json',
    time: new Date().toISOString(),
    subject: norm.address.toLowerCase(),
    data: {
      chainKey,
      chainId,
      registryAddress: norm.address.toLowerCase(),
      tokenId: '0',
      blockNumber: norm.blockNumber,
      transactionHash: norm.transactionHash,
      logIndex: norm.logIndex,
      idempotencyKey: `${chainId}-${norm.transactionHash}-${norm.logIndex}`,
      payload: { account: account.toLowerCase(), remark },
    },
  };
}

export function normalizeFactoryEvent(
  escrowAddress: string,
  registryAddress: string,
  tokenId: bigint,
  norm: NormalizedLog,
  chainKey: string,
  chainId: number,
  owner?: string,
  holder?: string,
  remark?: string,
): CloudEvent {
  const payload: Record<string, unknown> = {
    escrowAddress: escrowAddress.toLowerCase(),
    registryAddress: registryAddress.toLowerCase(),
  };
  if (owner !== undefined) payload.owner = owner.toLowerCase();
  if (holder !== undefined) payload.holder = holder.toLowerCase();
  if (remark !== undefined) payload.remark = remark;
  return toCloudEvent('etr.escrow_created', chainKey, chainId, registryAddress.toLowerCase(), tokenId, norm, payload);
}

export function normalizeEscrowEvent(
  eventName: string,
  args: Record<string, unknown>,
  tokenId: bigint,
  registryAddress: string,
  norm: NormalizedLog,
  chainKey: string,
  chainId: number,
): CloudEvent | null {
  const typeMap: Record<string, string> = {
    TokenReceived: 'etr.token_received',
    Nomination: 'etr.nomination',
    BeneficiaryTransfer: 'etr.beneficiary_transfer',
    HolderTransfer: 'etr.holder_transfer',
    ReturnToIssuer: 'etr.return_to_issuer',
    Shred: 'etr.shred',
    RejectTransferBeneficiary: 'etr.reject_transfer_beneficiary',
    RejectTransferHolder: 'etr.reject_transfer_holder',
    RejectTransferOwners: 'etr.reject_transfer_owners',
  };

  const eventType = typeMap[eventName];
  if (!eventType) return null;

  return toCloudEvent(eventType, chainKey, chainId, registryAddress.toLowerCase(), tokenId, norm, args);
}
