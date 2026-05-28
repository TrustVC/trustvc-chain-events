/** Promise-based delay. Used by retry loops and drain polling. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
