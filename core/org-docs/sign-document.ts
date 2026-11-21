// The document the agent asks to sign, read and checked before anything opens it (docs/specs/[20.11.2026]-org-letterhead.md,
// independent review 21.11): the agent makes the file itself, so it can be built to hold the server — a file of gigabytes,
// an archive that unpacks into gigabytes. Its size is read from the opened file and its archive's directory before a byte
// is unpacked, as the viewer and the letterhead do. And the card «Да» is about these bytes: their fingerprint waits for
// the answer, and after «Да» only the same bytes are signed.
import { createHash } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { MAX_UPLOAD_BYTES } from '@bba/contracts';
import { unzipSync } from 'fflate';
import type pg from 'pg';
import { appError } from '../errors/catalog.ts';
import { unpackedBytesOf } from '../preview/checks.ts';
import { openFileInside } from '../workspace/layout.ts';
import { BLANK_MAX_UNPACKED_BYTES } from './blank.ts';
import { SIGN_MARK } from './prompt.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

// A question «Да» lives up to 720 hours — the longest term an admin may set (APPROVAL_TTL_HOURS_MAX); a fingerprint
// of a card nobody answered goes a day after that.
const PENDING_KEEP = '31 days';
const TOO_BIG = 'Документ слишком большой для печати и подписи: больше 20 МБ или распаковывается в огромный архив. Сделай его заново, без лишних картинок.';

export const fingerprintOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// The bytes of a regular file of the folder (a link out of it, a pipe — refused by openFileInside); null — no file.
export function readSignable(root: string, path: string): Buffer | null {
  const file = openFileInside(root, path);
  if (!file) return null;
  try {
    if (file.size > MAX_UPLOAD_BYTES) throw appError('APP_SIGN_TOO_BIG', `document to sign is ${file.size} bytes`, { userMessage: TOO_BIG });
    return readFileSync(file.fd);
  } finally {
    closeSync(file.fd);
  }
}

// What its archive says it unpacks into, before unpacking: within what a letterhead may.
export function assertUnpackable(bytes: Uint8Array): void {
  const unpacked = unpackedBytesOf(bytes);
  if (unpacked === null) throw appError('APP_SIGN_FORMAT', 'document to sign is not a zip archive');
  if (unpacked > BLANK_MAX_UNPACKED_BYTES) throw appError('APP_SIGN_TOO_BIG', `document to sign unpacks into ${unpacked} bytes`, { userMessage: TOO_BIG });
}

// The mark in one paragraph of a part of the text (its pieces joined: Word cuts it into runs), as sign.py looks for it.
// Parts are any XML of the document: the main one may be named otherwise than document.xml.
export function hasMark(bytes: Uint8Array): boolean {
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith('word/') && f.name.endsWith('.xml') && !f.name.includes('/_rels/') });
  return Object.values(files).some((xml) =>
    new TextDecoder()
      .decode(xml)
      .split('</w:p>')
      .some((paragraph) => [...paragraph.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').includes(SIGN_MARK)),
  );
}

// The card is about these bytes: their fingerprint waits for «Да» by the call it belongs to.
export async function rememberAsked(db: Queryable, toolCallId: string, userId: string, sha256: string): Promise<void> {
  await db.query(`DELETE FROM app.org_sign_pending WHERE created_at < now() - interval '${PENDING_KEEP}'`);
  await db.query(
    `INSERT INTO app.org_sign_pending (tool_call_id, user_id, sha256) VALUES ($1, $2, $3)
     ON CONFLICT (tool_call_id) DO UPDATE SET sha256 = EXCLUDED.sha256, user_id = EXCLUDED.user_id, created_at = now()`,
    [toolCallId, userId, sha256],
  );
}

// The fingerprint the card was shown with, taken once: null — no card was shown for this call.
export async function takeAsked(db: Queryable, toolCallId: string, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ sha256: string }>('DELETE FROM app.org_sign_pending WHERE tool_call_id = $1 AND user_id = $2 RETURNING sha256', [toolCallId, userId]);
  return rows[0]?.sha256 ?? null;
}
