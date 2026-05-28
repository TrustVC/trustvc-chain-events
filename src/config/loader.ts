import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigSchema, type AppConfig } from './schema.js';

const CONFIG_PATH = process.env['CONFIG_PATH'] ?? './config.json';

function interpolateEnv(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new Error(`Environment variable "${name}" is referenced in config but is not set`);
    }
    return value;
  });
}

export function loadConfig(): AppConfig {
  let raw: unknown;
  try {
    const text = readFileSync(resolve(CONFIG_PATH), 'utf-8');
    raw = JSON.parse(interpolateEnv(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config at ${CONFIG_PATH}: ${msg}`);
  }

  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }
  return result.data;
}
