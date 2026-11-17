// The row of app.storage_settings (spec, section 8.23): where files are stored and the bucket's keys,
// sealed by the installation's encryption key.
import type { StorageProvider } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import type { S3Config } from './object-store.ts';

export type StorageState = 'active' | 'to_s3' | 'to_local';

export type StorageSettings =
  | { mode: 'local'; state: 'active'; lastError: { code: string; at: Date } | null }
  | { mode: 's3'; state: StorageState; provider: StorageProvider; config: S3Config; connectedAt: Date; lastError: { code: string; at: Date } | null };

interface Row {
  mode: 'local' | 's3';
  state: StorageState;
  provider: StorageProvider | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string;
  path_style: boolean | null;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  key_version: number | null;
  connected_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
}

export async function loadStorageSettings(db: Db, box: SecretBox): Promise<StorageSettings> {
  const { rows } = await db.query<Row>('SELECT * FROM app.storage_settings');
  const row = rows[0];
  if (!row) throw new Error('APP_CONFIG_INVALID: app.storage_settings has no row: migration 0025 did not run');
  const lastError = row.last_error_code && row.last_error_at ? { code: row.last_error_code, at: row.last_error_at } : null;
  if (row.mode === 'local') return { mode: 'local', state: 'active', lastError };
  let keys: { accessKeyId: string; secretAccessKey: string };
  try {
    keys = JSON.parse(box.open({ ciphertext: row.ciphertext!, iv: row.iv!, keyVersion: row.key_version! })) as typeof keys;
  } catch (error) {
    throw new AppError({
      code: 'APP_STORAGE_DECRYPT_FAILED',
      message: 'the keys of the S3 bucket cannot be decrypted',
      userMessage: 'Не удалось прочитать ключи хранилища файлов: ключ шифрования установки сменился без переноса.',
      nextStep: 'Верните прежний ключ в APP_ENCRYPTION_KEYS или введите ключи хранилища заново.',
      status: 500,
      cause: error,
    });
  }
  return {
    mode: 's3',
    state: row.state,
    provider: row.provider!,
    config: { endpoint: row.endpoint!, region: row.region!, bucket: row.bucket!, prefix: row.prefix, pathStyle: row.path_style!, ...keys },
    connectedAt: row.connected_at!,
    lastError,
  };
}

export async function saveS3Settings(db: Db, box: SecretBox, input: { provider: StorageProvider; config: S3Config; state: StorageState }): Promise<void> {
  const { accessKeyId, secretAccessKey, endpoint, region, bucket, prefix, pathStyle } = input.config;
  const sealed = box.seal(JSON.stringify({ accessKeyId, secretAccessKey }));
  await db.query(
    `UPDATE app.storage_settings SET mode = 's3', state = $1, provider = $2, endpoint = $3, region = $4, bucket = $5, prefix = $6, path_style = $7,
       ciphertext = $8, iv = $9, key_version = $10, connected_at = COALESCE(CASE WHEN mode = 's3' THEN connected_at END, now()),
       last_error_code = NULL, last_error_at = NULL, updated_at = now()`,
    [input.state, input.provider, endpoint, region, bucket, prefix, pathStyle, sealed.ciphertext, sealed.iv, sealed.keyVersion],
  );
}

export async function setStorageState(db: Db, state: StorageState): Promise<void> {
  await db.query("UPDATE app.storage_settings SET state = $1, updated_at = now() WHERE mode = 's3'", [state]);
}

// Back to the server's disk: the bucket and its keys are forgotten.
export async function saveLocalSettings(db: Db): Promise<void> {
  await db.query(
    `UPDATE app.storage_settings SET mode = 'local', state = 'active', provider = NULL, endpoint = NULL, region = NULL, bucket = NULL, prefix = '',
       path_style = NULL, ciphertext = NULL, iv = NULL, key_version = NULL, connected_at = NULL, last_error_code = NULL, last_error_at = NULL, updated_at = now()`,
  );
}

export async function recordStorageError(db: Db, code: string | null): Promise<void> {
  await db.query('UPDATE app.storage_settings SET last_error_code = $1, last_error_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END', [code]);
}
