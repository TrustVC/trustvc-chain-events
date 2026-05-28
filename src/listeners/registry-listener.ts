import { Contract, type ContractEventPayload, type Provider } from 'ethers';
import type { Logger } from 'pino';
import { REGISTRY_ABI } from '../contracts/abis.js';
import { normalizeRegistryTransfer, normalizeRegistryPause } from '../delivery/event-normalizer.js';
import type { IWebhookEmitter } from '../interfaces/emitter.js';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import { toNormalizedLog } from '../utils/eth.js';
import { meter } from '../telemetry/index.js';

const eventsReceived = meter.createCounter('trustvc.chain.events_received', {
  description: 'On-chain ETR events detected per chain and event type',
});

export class RegistryListener {
  private readonly contract: Contract;

  constructor(
    private readonly registryAddress: string,
    private readonly chainKey: string,
    private readonly chainId: number,
    private readonly provider: Provider,
    private readonly emitter: IWebhookEmitter,
    private readonly log: Logger,
    private readonly confirmations: number = 1,
  ) {
    this.contract = new Contract(registryAddress, REGISTRY_ABI, provider);
  }

  start(): void {
    // Single wildcard subscription covers Transfer, PauseWithRemark, and
    // UnpauseWithRemark — avoids three separate eth_subscribe calls.
    this.contract.on('*', (...args: unknown[]) => {
      const payload = args[args.length - 1] as ContractEventPayload;
      const eventName = payload?.fragment?.name;
      if (!eventName || !payload?.log) return;

      eventsReceived.add(1, { chain: this.chainKey, event_type: eventName });
      const norm = toNormalizedLog(payload.log);

      if (eventName === 'Transfer') {
        const from = args[0] as string;
        const to = args[1] as string;
        const tokenId = args[2] as bigint;
        const event = normalizeRegistryTransfer({ from, to, tokenId }, norm, this.chainKey, this.chainId);
        if (event) {
          void this.emitAfterConfirmations(norm.transactionHash, event, 'registry transfer');
        }
      } else if (eventName === 'PauseWithRemark') {
        const account = args[0] as string;
        const remark = args[1] as string;
        const event = normalizeRegistryPause('PauseWithRemark', account, remark, norm, this.chainKey, this.chainId);
        void this.emitAfterConfirmations(norm.transactionHash, event, 'pause');
      } else if (eventName === 'UnpauseWithRemark') {
        const account = args[0] as string;
        const remark = args[1] as string;
        const event = normalizeRegistryPause('UnpauseWithRemark', account, remark, norm, this.chainKey, this.chainId);
        void this.emitAfterConfirmations(norm.transactionHash, event, 'unpause');
      }
    });

    this.log.info({ registry: this.registryAddress, chain: this.chainKey }, 'Registry listener started');
  }

  // Waits for the required number of block confirmations before forwarding the
  // event to the emitter. confirmations=1 skips the wait entirely.
  // On timeout or provider teardown the event is emitted best-effort rather than dropped.
  private async emitAfterConfirmations(txHash: string, event: CloudEvent, label: string): Promise<void> {
    if (this.confirmations > 1) {
      try {
        await this.provider.waitForTransaction(txHash, this.confirmations, 120_000);
      } catch {
        // Timeout or provider destroyed — emit best-effort with the data we already have.
      }
    }
    this.emitter.emit(event).catch((err) => {
      this.log.error({ err, registry: this.registryAddress }, `Failed to emit ${label} event`);
    });
  }

  stop(): void {
    this.contract.removeAllListeners();
  }
}
