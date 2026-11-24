// Personal credentials of employees for connected systems (spec, section 8.8):
// encrypted JSON (AES-256-GCM) in app.connector_credentials, with the key version next to it.
import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';

export type CredentialStatus = 'connected' | 'unverified' | 'auth_error';

export type StoredCredential =
  | { kind: 'static'; fields: Record<string, string> }
  // `issuer` and `discovery` — of the sign-in by the MCP standard (MCP servers): who issued the tokens and where
  // its addresses are, so a refresh needs no new discovery and a token of another issuer is never sent.
  | { kind: 'oauth'; accessToken: string; refreshToken: string | null; expiresAt: string | null; issuer?: string; discovery?: OAuthDiscoveryState };

export interface CredentialRecord {
  credential: StoredCredential;
  status: CredentialStatus;
  checkedAt: Date | null;
  lastErrorCode: string | null;
}

export function decryptFailed(connectorTitle: string, cause: unknown): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_DECRYPT_FAILED',
    message: `stored credential for ${connectorTitle} cannot be decrypted`,
    userMessage: `Не удалось прочитать ваш доступ к ${connectorTitle} — проблема на сервере, переподключение не поможет. Сообщите администратору код ошибки.`,
    status: 500,
    cause,
  });
}

export async function saveCredential(
  db: Pick<Db, 'query'>,
  box: SecretBox,
  input: { userId: string; connectorId: string; credential: StoredCredential; status: CredentialStatus; lastErrorCode?: string | null },
): Promise<void> {
  const sealed = box.seal(JSON.stringify(input.credential));
  const expiresAt = input.credential.kind === 'oauth' ? input.credential.expiresAt : null;
  await db.query(
    `INSERT INTO app.connector_credentials (user_id, connector_id, kind, ciphertext, iv, key_version, expires_at, status, checked_at, last_error_code, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 <> 'unverified' THEN now() END, $9, now())
     ON CONFLICT (user_id, connector_id) DO UPDATE SET kind = EXCLUDED.kind, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
       key_version = EXCLUDED.key_version, expires_at = EXCLUDED.expires_at, status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
       last_error_code = EXCLUDED.last_error_code, updated_at = now()`,
    [input.userId, input.connectorId, input.credential.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion, expiresAt, input.status, input.lastErrorCode ?? null],
  );
}

export async function loadCredential(db: Pick<Db, 'query'>, box: SecretBox, userId: string, connectorId: string, connectorTitle: string): Promise<CredentialRecord | null> {
  const { rows } = await db.query<{ ciphertext: Buffer; iv: Buffer; key_version: number; status: CredentialStatus; checked_at: Date | null; last_error_code: string | null }>(
    'SELECT ciphertext, iv, key_version, status, checked_at, last_error_code FROM app.connector_credentials WHERE user_id = $1 AND connector_id = $2',
    [userId, connectorId],
  );
  const row = rows[0];
  if (!row) return null;
  let credential: StoredCredential;
  try {
    credential = JSON.parse(box.open({ ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version })) as StoredCredential;
  } catch (error) {
    throw decryptFailed(connectorTitle, error);
  }
  return { credential, status: row.status, checkedAt: row.checked_at, lastErrorCode: row.last_error_code };
}

export async function setCredentialStatus(db: Db, userId: string, connectorId: string, status: CredentialStatus, errorCode: string | null): Promise<void> {
  await db.query('UPDATE app.connector_credentials SET status = $3, checked_at = now(), last_error_code = $4, updated_at = now() WHERE user_id = $1 AND connector_id = $2', [
    userId,
    connectorId,
    status,
    errorCode,
  ]);
}

// The system refused the employee's access: «Ошибка доступа», and the employee is told — once per breakage, when the
// access turns from working to broken (docs/specs/[20.11.2026]-notifications.md).
export async function markCredentialBroken(db: Pick<Db, 'query'>, input: { userId: string; connectorId: string; title: string; errorCode: string }): Promise<void> {
  const { rows } = await db.query<{ was: CredentialStatus }>(
    `UPDATE app.connector_credentials c SET status = 'auth_error', checked_at = now(), last_error_code = $3, updated_at = now()
       FROM (SELECT user_id, connector_id, status AS was FROM app.connector_credentials WHERE user_id = $1 AND connector_id = $2 FOR UPDATE) o
      WHERE c.user_id = o.user_id AND c.connector_id = o.connector_id RETURNING o.was`,
    [input.userId, input.connectorId, input.errorCode],
  );
  const was = rows[0]?.was;
  if (was && was !== 'auth_error') {
    await notify(db, notices.connectionBroken({ userId: input.userId, connectionKey: `connector:${input.connectorId}`, title: input.title, brokenAt: new Date() }));
  }
}

export async function deleteCredential(db: Db, userId: string, connectorId: string): Promise<void> {
  await db.query('DELETE FROM app.connector_credentials WHERE user_id = $1 AND connector_id = $2', [userId, connectorId]);
}
