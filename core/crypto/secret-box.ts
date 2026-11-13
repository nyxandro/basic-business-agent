// AES-256-GCM for secrets stored in the database (spec, sections 8.1 and 8.8).
// APP_ENCRYPTION_KEYS = "<version>:<base64 32 bytes>[,<version>:<base64>]"; the first key encrypts,
// every listed key decrypts. Rotation: put the new key first, keep the old one until rows are re-encrypted.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors/app-error.ts';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer; // encrypted data followed by the 16-byte authentication tag
  iv: Buffer;
  keyVersion: number;
}

export interface SecretBox {
  seal(plaintext: string): Sealed;
  open(sealed: Sealed): string;
}

export function parseEncryptionKeys(raw: string): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [version, b64] = part.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!/^\d+$/.test(version ?? '') || key.length !== KEY_BYTES) {
      throw new Error(`APP_CONFIG_INVALID: .env: APP_ENCRYPTION_KEYS: each entry must be "<version>:<base64 of ${KEY_BYTES} bytes>"`);
    }
    keys.set(Number(version), key);
  }
  if (keys.size === 0) throw new Error('APP_CONFIG_INVALID: .env: APP_ENCRYPTION_KEYS: is empty');
  return keys;
}

export function createSecretBox(raw: string): SecretBox {
  const keys = parseEncryptionKeys(raw);
  const [currentVersion, currentKey] = [...keys.entries()][0]!;
  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, currentKey, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return { ciphertext: data, iv, keyVersion: currentVersion };
    },
    open({ ciphertext, iv, keyVersion }) {
      const key = keys.get(keyVersion);
      if (!key) {
        throw new AppError({
          code: 'APP_SECRET_KEY_UNKNOWN',
          message: `no encryption key with version ${keyVersion} in APP_ENCRYPTION_KEYS`,
          userMessage: 'Не удалось прочитать сохранённый доступ — проблема на сервере. Сообщите администратору код ошибки.',
          status: 500,
        });
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
        return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), decipher.final()]).toString('utf8');
      } catch (error) {
        throw new AppError({
          code: 'APP_SECRET_DECRYPT_FAILED',
          message: `decryption with key version ${keyVersion} failed`,
          userMessage: 'Не удалось прочитать сохранённый доступ — проблема на сервере. Сообщите администратору код ошибки.',
          status: 500,
          cause: error,
        });
      }
    },
  };
}
