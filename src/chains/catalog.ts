export type TransportType = 'websocket' | 'http-polling';

export interface ChainDef {
  key: string;
  chainId: number;
  transport: TransportType;
  pollIntervalMs: number;
  pingIntervalMs: number;
}

export const CHAIN_CATALOG: ChainDef[] = [
  {
    key: 'ethereum',
    chainId: 1,
    transport: 'websocket',
    pollIntervalMs: 12_000,
    pingIntervalMs: 30_000,
  },
  {
    key: 'ethereum-sepolia',
    chainId: 11155111,
    transport: 'websocket',
    pollIntervalMs: 12_000,
    pingIntervalMs: 30_000,
  },
  {
    key: 'polygon',
    chainId: 137,
    transport: 'websocket',
    pollIntervalMs: 2_000,
    pingIntervalMs: 20_000,
  },
  {
    key: 'polygon-amoy',
    chainId: 80002,
    transport: 'websocket',
    pollIntervalMs: 2_000,
    pingIntervalMs: 20_000,
  },
  {
    key: 'xdc',
    chainId: 50,
    transport: 'websocket',
    pollIntervalMs: 2_000,
    pingIntervalMs: 25_000,
  },
  {
    key: 'xdc-apothem',
    chainId: 51,
    transport: 'websocket',
    pollIntervalMs: 2_000,
    pingIntervalMs: 25_000,
  },
  {
    key: 'stability',
    chainId: 101010,
    transport: 'http-polling',
    pollIntervalMs: 10_000,
    pingIntervalMs: 20_000,
  },
  {
    key: 'stability-testnet',
    chainId: 20180427,
    transport: 'http-polling',
    pollIntervalMs: 10_000, // 10 seconds
    pingIntervalMs: 20_000,
  },
  {
    key: 'astron',
    chainId: 1338,
    transport: 'http-polling',
    pollIntervalMs: 5_000,
    pingIntervalMs: 20_000,
  },
  {
    key: 'astron-testnet',
    chainId: 21002,
    transport: 'http-polling',
    pollIntervalMs: 5_000,
    pingIntervalMs: 20_000,
  },
];

export const CHAIN_CATALOG_BY_KEY = new Map(CHAIN_CATALOG.map((c) => [c.key, c]));
export const CHAIN_CATALOG_BY_ID = new Map(CHAIN_CATALOG.map((c) => [c.chainId, c]));
