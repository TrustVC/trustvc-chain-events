// Different RPC providers surface rate limits differently — check all known shapes.
export function isRateLimit(err: unknown): boolean {
  if (err == null) return false;
  // ethers v6 wraps JSON-RPC errors under err.error
  const nested = (err as { error?: { code?: unknown } }).error;
  if (nested?.code === 429) return true;
  if ((err as { code?: unknown }).code === 429) return true;
  // String scan covers providers that embed the code in the message (e.g. Alchemy CU limit)
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('compute units');
}

// ethers v6 throws UNSUPPORTED_OPERATION/eth_subscribe when the underlying
// WebSocket is closed; callers use this to skip cleanup on stale listeners.
export function isProviderDestroyed(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: string; operation?: string; shortMessage?: string; message?: string };
  if (e.code !== 'UNSUPPORTED_OPERATION') return false;
  const msg = `${e.shortMessage ?? ''} ${e.message ?? ''}`;
  return e.operation === 'eth_subscribe' || msg.includes('provider destroyed');
}
