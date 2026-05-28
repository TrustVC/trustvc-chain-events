export interface NormalizedLog {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  address: string;
}

export interface EventData {
  chainKey: string;
  chainId: number;
  registryAddress: string;
  tokenId: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  // Stable key consumers can use to deduplicate: "<chainId>-<txHash>-<logIndex>"
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface CloudEvent {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  datacontenttype: 'application/json';
  time: string;
  subject: string;
  data: EventData;
}
