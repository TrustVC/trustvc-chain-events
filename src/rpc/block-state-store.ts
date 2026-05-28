import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

interface PersistedState {
  lastSeenBlock: number;
}

export class BlockStateStore {
  private readonly filePath: string;

  constructor(stateDir: string, chainKey: string) {
    this.filePath = join(stateDir, `${chainKey}.json`);
  }

  async read(): Promise<number | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      return typeof parsed.lastSeenBlock === 'number' ? parsed.lastSeenBlock : null;
    } catch {
      return null;
    }
  }

  async write(lastSeenBlock: number): Promise<void> {
    await mkdir(this.filePath.replace(/\/[^/]+$/, ''), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ lastSeenBlock }), 'utf8');
  }
}
