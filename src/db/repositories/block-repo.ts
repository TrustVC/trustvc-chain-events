import { BlockProgress } from '../models/block-progress.js';

export async function readBlock(chainKey: string): Promise<number | null> {
  const row = await BlockProgress.findByPk(chainKey);
  return row?.lastSeenBlock ?? null;
}

export async function writeBlock(chainKey: string, lastSeenBlock: number): Promise<void> {
  await BlockProgress.upsert({ chainKey, lastSeenBlock });
}
