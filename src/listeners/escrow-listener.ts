import { Contract, type ContractEventPayload, type Provider } from 'ethers';
import type { Logger } from 'pino';
import { ESCROW_ABI } from '../contracts/abis.js';
import { normalizeEscrowEvent } from '../delivery/event-normalizer.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import { toNormalizedLog } from '../utils/eth.js';
import { meter } from '../telemetry/index.js';

const eventsReceived = meter.createCounter('trustvc.chain.events_received', {
  description: 'On-chain ETR events detected per chain and event type',
});

// All nine escrow event names. Only these trigger webhook emission.
const ESCROW_EVENT_NAMES = new Set([
  'TokenReceived',
  'Nomination',
  'BeneficiaryTransfer',
  'HolderTransfer',
  'ReturnToIssuer',
  'Shred',
  'RejectTransferBeneficiary',
  'RejectTransferHolder',
  'RejectTransferOwners',
]);

export class EscrowListener {
  private readonly contract: Contract;

  constructor(
    private readonly escrowAddress: string,
    private readonly registryAddress: string,
    private readonly tokenId: bigint,
    private readonly chainKey: string,
    private readonly chainId: number,
    private readonly provider: Provider,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
    private readonly confirmations: number = 1,
    // Called after a Shred event is delivered so FactoryListener can clean up its maps.
    private readonly onShred?: () => void,
  ) {
    this.contract = new Contract(escrowAddress, ESCROW_ABI, provider);
  }

  start(): void {
    // Single wildcard subscription covers all nine event types in one eth_subscribe call.
    this.contract.on('*', (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const eventName = payload?.fragment?.name;
      if (!eventName || !ESCROW_EVENT_NAMES.has(eventName)) return;

      const norm = toNormalizedLog(payload.log);
      const namedArgs: Record<string, unknown> = {};
      if (payload.args) {
        for (const [k, v] of Object.entries(payload.args.toObject())) {
          namedArgs[k] = typeof v === 'bigint' ? v.toString() : v;
        }
      }

      const event = normalizeEscrowEvent(
        eventName,
        namedArgs,
        this.tokenId,
        this.registryAddress,
        norm,
        this.chainKey,
        this.chainId,
      );

      if (event) {
        void this.deliverEvent(event, eventName, norm.transactionHash);
      }
    });
    this.log.debug({ escrow: this.escrowAddress, tokenId: this.tokenId.toString() }, 'Escrow listener started');
  }

  private async deliverEvent(event: CloudEvent, eventName: string, txHash: string): Promise<void> {
    eventsReceived.add(1, { chain: this.chainKey, event_type: eventName });
    if (this.confirmations > 1) {
      await this.provider.waitForTransaction(txHash, this.confirmations);
    }
    this.emitter.emit(event).catch((err) => {
      this.log.error({ err, event: eventName, escrow: this.escrowAddress }, 'Failed to emit escrow event');
    });
    if (eventName === 'Shred') {
      this.stop();
      this.onShred?.();
    }
  }

  stop(): void {
    this.contract.removeAllListeners();
  }
}
