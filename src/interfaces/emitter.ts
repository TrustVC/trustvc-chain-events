import type { CloudEvent } from './cloud-event.js';

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface IWebhookEmitter {
  emit(event: CloudEvent): Promise<DeliveryResult>;
}
