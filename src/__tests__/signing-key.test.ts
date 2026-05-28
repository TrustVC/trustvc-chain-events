import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createSigningKeyManager } from '../signing/signing-key.js';

const { privateKey: testPrivateKey, publicKey: testPublicKey } = generateKeyPairSync('ed25519');
const testPem = testPrivateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const testDer = testPrivateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
// PKCS8_ED25519_PREFIX is 16 bytes; seed follows
const testSeed = testDer.subarray(16);
const testBase64Seed = testSeed.toString('base64');

describe('createSigningKeyManager', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when SIGNING_PRIVATE_KEY is not set', () => {
    delete process.env['SIGNING_PRIVATE_KEY'];
    expect(() => createSigningKeyManager()).toThrow('SIGNING_PRIVATE_KEY');
  });

  it('throws with wrong key type (RSA)', () => {
    const { privateKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsaKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    vi.stubEnv('SIGNING_PRIVATE_KEY', rsaPem);
    expect(() => createSigningKeyManager()).toThrow('Ed25519');
  });

  it('parses PEM-encoded Ed25519 private key', () => {
    vi.stubEnv('SIGNING_PRIVATE_KEY', testPem);
    expect(() => createSigningKeyManager()).not.toThrow();
  });

  it('parses 32-byte base64 seed', () => {
    vi.stubEnv('SIGNING_PRIVATE_KEY', testBase64Seed);
    expect(() => createSigningKeyManager()).not.toThrow();
  });

  it('throws on base64 seed shorter than 32 bytes', () => {
    vi.stubEnv('SIGNING_PRIVATE_KEY', Buffer.alloc(31).toString('base64'));
    expect(() => createSigningKeyManager()).toThrow('31 bytes');
  });

  it('throws on base64 seed longer than 32 bytes', () => {
    vi.stubEnv('SIGNING_PRIVATE_KEY', Buffer.alloc(33).toString('base64'));
    expect(() => createSigningKeyManager()).toThrow('33 bytes');
  });

  it('throws on string that decodes to wrong byte length', () => {
    // 'AAEC' in base64 = 3 bytes, which is not 32
    vi.stubEnv('SIGNING_PRIVATE_KEY', 'AAEC');
    expect(() => createSigningKeyManager()).toThrow();
  });

  describe('sign()', () => {
    it('returns a base64url string', () => {
      vi.stubEnv('SIGNING_PRIVATE_KEY', testBase64Seed);
      const manager = createSigningKeyManager();
      const sig = manager.sign(Buffer.from('hello'));
      expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('output is verifiable with the corresponding public key', () => {
      vi.stubEnv('SIGNING_PRIVATE_KEY', testBase64Seed);
      const manager = createSigningKeyManager();
      const payload = Buffer.from('test payload');
      const sigBase64url = manager.sign(payload);
      const sigBuffer = Buffer.from(sigBase64url, 'base64url');
      expect(verify(null, payload, testPublicKey, sigBuffer)).toBe(true);
    });

    it('produces same signature for same payload (deterministic Ed25519)', () => {
      vi.stubEnv('SIGNING_PRIVATE_KEY', testBase64Seed);
      const manager = createSigningKeyManager();
      const payload = Buffer.from('deterministic');
      expect(manager.sign(payload)).toBe(manager.sign(payload));
    });
  });
});
