import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox } from './secret-box.ts';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('secret box', () => {
  it('round-trips a secret and never stores it in the clear', () => {
    const box = createSecretBox(`1:${k1}`);
    const sealed = box.seal('sk-user-key-123');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('sk-user-key-123');
    expect(sealed.keyVersion).toBe(1);
    expect(box.open(sealed)).toBe('sk-user-key-123');
  });

  it('encrypts with the first key and still opens rows sealed with an older one', () => {
    const old = createSecretBox(`1:${k1}`).seal('old secret');
    const rotated = createSecretBox(`2:${k2},1:${k1}`);
    expect(rotated.open(old)).toBe('old secret');
    expect(rotated.seal('new').keyVersion).toBe(2);
  });

  it('fails with a code when the key version is gone or the data was changed', () => {
    const sealed = createSecretBox(`1:${k1}`).seal('x');
    expect(() => createSecretBox(`2:${k2}`).open(sealed)).toThrow(expect.objectContaining({ code: 'APP_SECRET_KEY_UNKNOWN' }));
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff;
    expect(() => createSecretBox(`1:${k1}`).open(sealed)).toThrow(expect.objectContaining({ code: 'APP_SECRET_DECRYPT_FAILED' }));
  });

  it('rejects a malformed key list', () => {
    expect(() => createSecretBox('1:short')).toThrow(/APP_ENCRYPTION_KEYS/);
    expect(() => createSecretBox('')).toThrow(/APP_ENCRYPTION_KEYS/);
  });
});
