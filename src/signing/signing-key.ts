import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

const ENV_VAR = 'SIGNING_PRIVATE_KEY';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface SigningKeyManager {
  sign(payload: Buffer): string;
}

export function createSigningKeyManager(): SigningKeyManager {
  const rawKey = process.env[ENV_VAR];
  if (!rawKey) {
    throw new Error(
      `${ENV_VAR} environment variable is required. Generate an Ed25519 key and set it before starting the server.`,
    );
  }

  const privateKey = parsePrivateKey(rawKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${ENV_VAR} must be an Ed25519 private key, got: ${privateKey.asymmetricKeyType}`);
  }

  return {
    sign(payload: Buffer): string {
      return sign(null, payload, privateKey).toString('base64url');
    },
  };
}

function parsePrivateKey(rawKey: string): KeyObject {
  try {
    if (rawKey.trimStart().startsWith('-----BEGIN')) {
      return createPrivateKey({ key: rawKey, format: 'pem' });
    }
    const seed = Buffer.from(rawKey, 'base64');
    if (seed.length !== 32) {
      throw new Error(`Expected 32-byte Ed25519 seed encoded as base64, got ${seed.length} bytes`);
    }
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${ENV_VAR}: ${msg}`);
  }
}
