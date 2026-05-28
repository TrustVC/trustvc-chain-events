import type { Logger } from 'pino';
import { SpanStatusCode } from '@opentelemetry/api';
import type { CloudEvent } from '../interfaces/cloud-event.js';
import type { DeliveryResult, IWebhookEmitter } from '../interfaces/emitter.js';
import type { WebhookConfig } from '../config/schema.js';
import type { SigningKeyManager } from '../signing/signing-key.js';
import { sleep } from '../utils/async.js';
import { tracer, meter } from '../telemetry/index.js';

export interface WebhookEmitterHandle extends IWebhookEmitter {
  /** Waits for all queued events to finish delivering (or timeoutMs elapses). */
  drain(timeoutMs?: number): Promise<void>;
  readonly queueSize: number;
}

// ── OTel instruments ──────────────────────────────────────────────────────────

const deliveredCounter = meter.createCounter('trustvc.webhook.delivered', {
  description: 'Successful webhook deliveries',
});
const failedCounter = meter.createCounter('trustvc.webhook.failed', {
  description: 'Webhook deliveries exhausted after all retries or dropped from full queue',
});
const deliveryDuration = meter.createHistogram('trustvc.webhook.delivery_duration_ms', {
  description: 'End-to-end webhook delivery duration including all retry attempts',
});
const queueDepth = meter.createObservableGauge('trustvc.webhook.queue_depth', {
  description: 'Events currently waiting in the delivery queue',
});
const chainEventsReceived = meter.createCounter('trustvc.chain.events_received', {
  description: 'On-chain events detected and enqueued for delivery, by chain and event type',
});

export function createWebhookEmitter(
  config: WebhookConfig,
  signer: SigningKeyManager,
  log: Logger,
): WebhookEmitterHandle {
  const MAX_CONCURRENT = config.maxConcurrentDeliveries;
  const MAX_QUEUE = config.maxQueueSize;
  const pending: CloudEvent[] = [];
  let activeWorkers = 0;

  queueDepth.addCallback((result) => result.observe(pending.length));

  function scheduleWorker(): void {
    while (activeWorkers < MAX_CONCURRENT && pending.length > 0) {
      const event = pending.shift()!;
      activeWorkers++;
      void doDeliver(event).finally(() => {
        activeWorkers--;
        scheduleWorker();
      });
    }
  }

  async function tryOnce(body: string, signature: string, attempt: number): Promise<DeliveryResult> {
    return tracer.startActiveSpan(`webhook attempt ${attempt}`, async (attemptSpan) => {
      attemptSpan.setAttributes({ 'http.attempt': attempt, 'http.url': config.url });
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
        log.info({ url: config.url, type: (JSON.parse(body) as { type?: string }).type }, 'Webhook delivery attempt');
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TrustVC-Signature': `ed25519=${signature}`,
            ...config.headers,
          },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        attemptSpan.setAttribute('http.status_code', response.status);
        attemptSpan.setStatus({ code: response.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        return { success: response.ok, statusCode: response.status, attempts: attempt, durationMs: Date.now() - t0 };
      } catch (err) {
        attemptSpan.recordException(err as Error);
        attemptSpan.setStatus({ code: SpanStatusCode.ERROR });
        return {
          success: false,
          attempts: attempt,
          durationMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        attemptSpan.end();
      }
    });
  }

  async function doDeliver(event: CloudEvent): Promise<void> {
    return tracer.startActiveSpan(
      `deliver ${event.type}`,
      {
        attributes: {
          'event.id': event.id,
          'event.type': event.type,
          'event.source': event.source,
          'webhook.url': config.url,
        },
      },
      async (span) => {
        const t0 = Date.now();
        const body = JSON.stringify(event);
        const signature = signer.sign(Buffer.from(body));
        let result: DeliveryResult = { success: false, attempts: 0, durationMs: 0 };

        try {
          for (let attempt = 1; attempt <= config.retryAttempts + 1; attempt++) {
            if (attempt > 1) await sleep(config.retryBackoffMs * 2 ** (attempt - 2));
            result = await tryOnce(body, signature, attempt);
            if (result.success) {
              deliveredCounter.add(1, { event_type: event.type });
              deliveryDuration.record(Date.now() - t0, { 'event.type': event.type, success: 'true' });
              span.setAttribute('delivery.attempts', attempt);
              span.setStatus({ code: SpanStatusCode.OK });
              log.info(
                { eventId: event.id, type: event.type, attempt, durationMs: Date.now() - t0 },
                'Webhook delivered',
              );
              return;
            }
            log.warn(
              { eventId: event.id, type: event.type, attempt, status: result.statusCode, error: result.error },
              'Webhook attempt failed',
            );
          }

          failedCounter.add(1, { event_type: event.type });
          deliveryDuration.record(Date.now() - t0, { 'event.type': event.type, success: 'false' });
          span.setAttribute('delivery.attempts', result.attempts);
          span.setStatus({ code: SpanStatusCode.ERROR, message: result.error ?? 'exhausted retries' });
          log.error({ eventId: event.id, type: event.type, attempts: result.attempts }, 'Webhook delivery exhausted');
        } finally {
          span.end();
        }
      },
    );
  }

  function emit(event: CloudEvent): Promise<DeliveryResult> {
    const eventAttrs = { chain: event.data.chainKey, event_type: event.type };
    if (pending.length >= MAX_QUEUE) {
      failedCounter.add(1, { event_type: event.type });
      log.error(
        { eventId: event.id, type: event.type, queueSize: pending.length },
        'Webhook queue full — dropping event',
      );
      return Promise.resolve({ success: false, attempts: 0, durationMs: 0, error: 'queue full' });
    }
    chainEventsReceived.add(1, eventAttrs);
    pending.push(event);
    scheduleWorker();
    return Promise.resolve({ success: true, attempts: 0, durationMs: 0 });
  }

  async function drain(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((pending.length > 0 || activeWorkers > 0) && Date.now() < deadline) {
      await sleep(100);
    }
    if (pending.length > 0 || activeWorkers > 0) {
      log.warn(
        { remaining: pending.length + activeWorkers },
        'Drain timeout — some events may not have been delivered',
      );
    }
  }

  return {
    emit,
    drain,
    get queueSize() {
      return pending.length;
    },
  };
}
