import { describe, it, expect } from 'vitest';
import {
  normalizeRegistryTransfer,
  normalizeRegistryPause,
  normalizeFactoryEvent,
  normalizeEscrowEvent,
} from '../delivery/event-normalizer.js';
import type { NormalizedLog } from '../interfaces/cloud-event.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const BURN = '0x000000000000000000000000000000000000dEaD';
const REGISTRY = '0xABCd1234ABCd1234ABCd1234ABCd1234ABCd1234';
const HOLDER = '0x1111111111111111111111111111111111111111';

const norm: NormalizedLog = {
  blockNumber: 100,
  transactionHash: '0xabc',
  logIndex: 0,
  address: REGISTRY,
};

describe('normalizeRegistryTransfer', () => {
  it('from=ZERO → etr.minted', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.type).toBe('com.trustvc.etr.minted');
  });

  it('to=BURN_ADDRESS → etr.burned', () => {
    const ev = normalizeRegistryTransfer({ from: HOLDER, to: BURN, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.type).toBe('com.trustvc.etr.burned');
  });

  it('to=registryAddress → etr.surrendered', () => {
    const ev = normalizeRegistryTransfer({ from: HOLDER, to: REGISTRY, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.type).toBe('com.trustvc.etr.surrendered');
  });

  it('to=registryAddress is case-insensitive', () => {
    const ev = normalizeRegistryTransfer(
      { from: HOLDER, to: REGISTRY.toLowerCase(), tokenId: 1n },
      { ...norm, address: REGISTRY.toUpperCase() },
      'ethereum',
      1,
    );
    expect(ev?.type).toBe('com.trustvc.etr.surrendered');
  });

  it('from=registryAddress → etr.restored', () => {
    const ev = normalizeRegistryTransfer({ from: REGISTRY, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.type).toBe('com.trustvc.etr.restored');
  });

  it('from=registryAddress is case-insensitive', () => {
    const ev = normalizeRegistryTransfer(
      { from: REGISTRY.toUpperCase(), to: HOLDER, tokenId: 1n },
      { ...norm, address: REGISTRY.toLowerCase() },
      'ethereum',
      1,
    );
    expect(ev?.type).toBe('com.trustvc.etr.restored');
  });

  it('unmatched transfer → returns null', () => {
    const other = '0x2222222222222222222222222222222222222222';
    expect(normalizeRegistryTransfer({ from: HOLDER, to: other, tokenId: 1n }, norm, 'ethereum', 1)).toBeNull();
  });

  it('registryAddress is lowercased in output', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.data.registryAddress).toBe(REGISTRY.toLowerCase());
  });

  it('tokenId is string in output', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 999n }, norm, 'ethereum', 1);
    expect(typeof ev?.data.tokenId).toBe('string');
    expect(ev?.data.tokenId).toBe('999');
  });

  it('output has a UUID id field', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('two calls produce different id values', () => {
    const ev1 = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    const ev2 = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev1?.id).not.toBe(ev2?.id);
  });

  it('source URN includes chainId and registry address', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 42);
    expect(ev?.source).toBe(`urn:trustvc:42:${REGISTRY.toLowerCase()}`);
  });

  it('type format is com.trustvc.etr.*', () => {
    const ev = normalizeRegistryTransfer({ from: ZERO, to: HOLDER, tokenId: 1n }, norm, 'ethereum', 1);
    expect(ev?.type).toMatch(/^com\.trustvc\.etr\./);
  });
});

describe('normalizeRegistryPause', () => {
  it('PauseWithRemark → etr.registry_paused', () => {
    const ev = normalizeRegistryPause('PauseWithRemark', 'maintenance', norm, 'ethereum', 1);
    expect(ev.type).toBe('com.trustvc.etr.registry_paused');
  });

  it('UnpauseWithRemark → etr.registry_unpaused', () => {
    const ev = normalizeRegistryPause('UnpauseWithRemark', '', norm, 'ethereum', 1);
    expect(ev.type).toBe('com.trustvc.etr.registry_unpaused');
  });

  it('remark is included in payload', () => {
    const ev = normalizeRegistryPause('PauseWithRemark', 'audit', norm, 'ethereum', 1);
    expect((ev.data.payload as { remark: string }).remark).toBe('audit');
  });

  it('subject is registry address not tokenId', () => {
    const ev = normalizeRegistryPause('PauseWithRemark', '', norm, 'ethereum', 1);
    expect(ev.subject).toBe(REGISTRY.toLowerCase());
  });
});

describe('normalizeFactoryEvent', () => {
  it('returns etr.escrow_created event', () => {
    const ev = normalizeFactoryEvent('0xescrow', REGISTRY, 1n, norm, 'ethereum', 1);
    expect(ev.type).toBe('com.trustvc.etr.escrow_created');
  });

  it('payload includes both escrowAddress and registryAddress', () => {
    const ev = normalizeFactoryEvent('0xEscrow', REGISTRY, 1n, norm, 'ethereum', 1);
    expect(ev.data.payload).toMatchObject({
      escrowAddress: '0xescrow',
      registryAddress: REGISTRY.toLowerCase(),
    });
  });
});

describe('normalizeEscrowEvent', () => {
  const escrowNorm: NormalizedLog = { blockNumber: 10, transactionHash: '0xdef', logIndex: 1, address: '0xescrow' };

  const CASES: Array<[string, string]> = [
    ['HolderTransfer', 'etr.holder_transfer'],
    ['BeneficiaryTransfer', 'etr.beneficiary_transfer'],
    ['TokenReceived', 'etr.token_received'],
    ['Nomination', 'etr.nomination'],
    ['ReturnToIssuer', 'etr.return_to_issuer'],
    ['Shred', 'etr.shred'],
    ['RejectTransferBeneficiary', 'etr.reject_transfer_beneficiary'],
    ['RejectTransferHolder', 'etr.reject_transfer_holder'],
    ['RejectTransferOwners', 'etr.reject_transfer_owners'],
  ];

  for (const [eventName, expectedType] of CASES) {
    it(`${eventName} → ${expectedType}`, () => {
      const ev = normalizeEscrowEvent(eventName, {}, 1n, REGISTRY, escrowNorm, 'ethereum', 1);
      expect(ev?.type).toBe(`com.trustvc.${expectedType}`);
    });
  }

  it('unknown event name → returns null', () => {
    expect(normalizeEscrowEvent('UnknownEvent', {}, 1n, REGISTRY, escrowNorm, 'ethereum', 1)).toBeNull();
  });

  it('args are passed through as payload', () => {
    const args = { fromHolder: '0xaaa', toHolder: '0xbbb' };
    const ev = normalizeEscrowEvent('HolderTransfer', args, 1n, REGISTRY, escrowNorm, 'ethereum', 1);
    expect(ev?.data.payload).toEqual(args);
  });
});
