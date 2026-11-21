// The files of «Профиль организации» (docs/specs/[20.11.2026]-org-letterhead.md): the letterhead, the logo, the stamp
// and the signature, kept in app.org_assets, and the director in app.org_profile. The browser prepares the pictures
// (cut, white made transparent, PNG), but the server does not rely on that: only PNG by its first bytes, its size read
// from the header, and a stamp without transparency is refused — it would lie as a white square over the signature line.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  ORG_BLANK_MAX_BYTES,
  ORG_IMAGE_MAX_BYTES,
  ORG_LOGO_MAX_SIDE_PX,
  ORG_STAMP_WIDTH_PX,
  type BlankInfo,
  type OrgAssetKind,
  type OrgAssetsState,
  type OrgDirector,
  type OrgPictureState,
} from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { imageSizeOf } from '../interface-settings/image-size.ts';
import { imageTypeOf } from '../interface-settings/image.ts';
import type { PreparedBlank } from './blank.ts';
import { listSigners } from './signers.ts';

export type OrgPictureKind = Exclude<OrgAssetKind, 'blank'>;

// A stamp or a signature is a line of a document wide; the logo may be bigger (slides).
const MAX_SIDE: Record<OrgPictureKind, number> = { logo: ORG_LOGO_MAX_SIDE_PX, stamp: ORG_STAMP_WIDTH_PX, signature: ORG_STAMP_WIDTH_PX };
const IMAGE_MESSAGE = 'Нужна картинка PNG или JPEG. Выберите её ещё раз — браузер подготовит её сам.';
const SIDE_MESSAGE = 'Картинка слишком большая. Выберите её ещё раз — браузер уменьшит её сам.';
const OPAQUE_STAMP = 'У печати должен быть прозрачный фон, иначе она закроет строку подписи белым прямоугольником. Включите «Убрать белый фон» и сохраните снова.';
const BLANK_EXTENSION = /\.docx$/i;

type Queryable = Pick<pg.PoolClient, 'query'>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const versionOf = (sha: string) => sha.slice(0, 12);

// Color types 4 (grey with alpha) and 6 (colour with alpha) carry transparency in every point; the others only with a
// tRNS chunk, which comes before the image data.
const PNG_HEADER_END = 8;
export function hasTransparency(png: Uint8Array): boolean {
  const colorType = png[25];
  if (colorType === 4 || colorType === 6) return true;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = PNG_HEADER_END; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + length;
  }
  return false;
}

export interface CheckedPicture {
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
}

export function checkPicture(kind: OrgPictureKind, bytes: Uint8Array): CheckedPicture {
  if (bytes.byteLength > ORG_IMAGE_MAX_BYTES) throw appError('APP_ORG_IMAGE_FORMAT', `${kind} is ${bytes.byteLength} bytes`, { userMessage: SIDE_MESSAGE });
  if (imageTypeOf(bytes) !== 'image/png') throw appError('APP_ORG_IMAGE_FORMAT', `${kind} is not PNG`, { userMessage: IMAGE_MESSAGE });
  const size = imageSizeOf(bytes, 'image/png');
  if (!size) throw appError('APP_ORG_IMAGE_FORMAT', `${kind} has no readable size`, { userMessage: IMAGE_MESSAGE });
  if (size.width > MAX_SIDE[kind] || size.height > MAX_SIDE[kind]) throw appError('APP_ORG_IMAGE_FORMAT', `${kind} is ${size.width}×${size.height} px`, { userMessage: SIDE_MESSAGE });
  if (kind === 'stamp' && !hasTransparency(bytes)) throw appError('APP_ORG_IMAGE_FORMAT', 'stamp has no transparency', { userMessage: OPAQUE_STAMP });
  return { bytes, sha256: sha256(bytes), ...size };
}

// The name and the size of an uploaded letterhead, before any program opens it.
export function checkBlankFile(fileName: string, bytes: Uint8Array): void {
  if (!BLANK_EXTENSION.test(fileName)) throw appError('APP_ORG_BLANK_FORMAT', `letterhead ${fileName.slice(-20)} is not .docx`);
  if (bytes.byteLength > ORG_BLANK_MAX_BYTES) throw appError('APP_ORG_BLANK_FORMAT', `letterhead is ${bytes.byteLength} bytes`, { userMessage: 'Бланк больше 5 МБ. Уберите из него крупные картинки и загрузите снова.' });
  if (bytes.byteLength === 0) throw appError('APP_ORG_BLANK_BROKEN', 'letterhead is empty');
}

interface AssetRow {
  kind: OrgAssetKind;
  sha256: string;
  file_name: string | null;
  blank_info: BlankInfo | null;
  width: number | null;
  height: number | null;
  director_name: string | null;
  updated_at: Date;
}

const picture = (r: AssetRow): OrgPictureState => ({ width: r.width!, height: r.height!, updatedAt: r.updated_at.toISOString(), version: versionOf(r.sha256) });

export async function readDirector(db: Queryable): Promise<OrgDirector> {
  const { rows } = await db.query<{ director_position: string; director_full_name: string; director_signature_name: string }>(
    'SELECT director_position, director_full_name, director_signature_name FROM app.org_profile',
  );
  const r = rows[0];
  if (!r) throw new Error('app.org_profile has no row: ensureOrgName runs at the start of the server');
  return { position: r.director_position, fullName: r.director_full_name, signatureName: r.director_signature_name };
}

// What the block «Бланк, печать и подпись» shows; the stamp, the signature and the responsible people only to a superadmin.
export async function orgAssetsState(db: Db, viewer: { isSuperadmin: boolean }): Promise<OrgAssetsState> {
  const { rows } = await db.query<AssetRow>('SELECT kind, sha256, file_name, blank_info, width, height, director_name, updated_at FROM app.org_assets');
  const of = (kind: OrgAssetKind) => rows.find((r) => r.kind === kind) ?? null;
  const blank = of('blank');
  const logo = of('logo');
  const stamp = of('stamp');
  const signature = of('signature');
  return {
    blank: blank ? { fileName: blank.file_name!, updatedAt: blank.updated_at.toISOString(), info: blank.blank_info! } : null,
    logo: logo ? picture(logo) : null,
    director: await readDirector(db),
    seal: viewer.isSuperadmin
      ? {
          stamp: stamp ? picture(stamp) : null,
          signature: signature ? { ...picture(signature), director: signature.director_name || null } : null,
          signers: await listSigners(db),
        }
      : null,
  };
}

export async function saveBlank(db: Db, actorUserId: string, file: { fileName: string; bytes: Uint8Array }, prepared: PreparedBlank): Promise<void> {
  const sha = sha256(file.bytes);
  await inTransaction(db, async (c) => {
    await c.query(
      `INSERT INTO app.org_assets (kind, content, sha256, file_name, prepared, preview, blank_info, uploaded_by, updated_at)
       VALUES ('blank', $1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (kind) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, file_name = EXCLUDED.file_name, prepared = EXCLUDED.prepared,
         preview = EXCLUDED.preview, blank_info = EXCLUDED.blank_info, uploaded_by = EXCLUDED.uploaded_by, updated_at = now()`,
      [Buffer.from(file.bytes), sha, file.fileName, prepared.prepared, prepared.preview, JSON.stringify(prepared.info), actorUserId],
    );
    await writeAudit(c, { actorUserId, action: 'org_assets.upload', target: 'blank', details: { sha256: sha, fileName: file.fileName, ...prepared.info } });
  });
}

export async function savePicture(db: Db, actorUserId: string, kind: OrgPictureKind, image: CheckedPicture): Promise<void> {
  await inTransaction(db, async (c) => {
    // The signature remembers whose it is: a new director in the profile asks for a new signature.
    const director = kind === 'signature' ? (await readDirector(c)).fullName : null;
    await c.query(
      `INSERT INTO app.org_assets (kind, content, sha256, width, height, director_name, uploaded_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (kind) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, width = EXCLUDED.width, height = EXCLUDED.height,
         director_name = EXCLUDED.director_name, uploaded_by = EXCLUDED.uploaded_by, updated_at = now()`,
      [kind, Buffer.from(image.bytes), image.sha256, image.width, image.height, director, actorUserId],
    );
    await writeAudit(c, { actorUserId, action: 'org_assets.upload', target: kind, details: { sha256: image.sha256, width: image.width, height: image.height } });
  });
}

export async function removeAsset(db: Db, actorUserId: string, kind: OrgAssetKind): Promise<void> {
  await inTransaction(db, async (c) => {
    const { rowCount } = await c.query('DELETE FROM app.org_assets WHERE kind = $1', [kind]);
    if (rowCount) await writeAudit(c, { actorUserId, action: 'org_assets.remove', target: kind });
  });
}

// The bytes of a file as uploaded: the letterhead or a picture.
export async function assetContent(db: Db, kind: OrgAssetKind): Promise<{ bytes: Buffer; sha256: string; fileName: string | null } | null> {
  const { rows } = await db.query<{ content: Buffer; sha256: string; file_name: string | null }>('SELECT content, sha256, file_name FROM app.org_assets WHERE kind = $1', [kind]);
  return rows[0] ? { bytes: rows[0].content, sha256: rows[0].sha256, fileName: rows[0].file_name } : null;
}

export async function blankPreview(db: Db): Promise<{ bytes: Buffer; sha256: string } | null> {
  const { rows } = await db.query<{ preview: Buffer; sha256: string }>("SELECT preview, sha256 FROM app.org_assets WHERE kind = 'blank'");
  return rows[0] ? { bytes: rows[0].preview, sha256: rows[0].sha256 } : null;
}

export async function saveDirector(db: Db, actorUserId: string, director: OrgDirector): Promise<void> {
  await inTransaction(db, async (c) => {
    await c.query('UPDATE app.org_profile SET director_position = $1, director_full_name = $2, director_signature_name = $3, updated_by = $4, updated_at = now()', [
      director.position,
      director.fullName,
      director.signatureName,
      actorUserId,
    ]);
    await writeAudit(c, { actorUserId, action: 'org_profile.director', target: null, details: { ...director } });
  });
}
