// «Профиль организации» → «Бланк, печать и подпись» (docs/specs/[20.11.2026]-org-letterhead.md, section 17): the
// letterhead and the logo — right «Профиль организации»; the stamp, the signature and the responsible people — only a
// superadmin, who alone sees them too (independent review 20.11: otherwise whoever has the right would make themselves
// responsible). Every change goes to the audit.
import { ORG_ASSET_KINDS, ORG_BLANK_MAX_BYTES, orgDirectorSchema, orgSignersSchema, SUPERADMIN_ASSETS, type OrgAssetKind } from '@bba/contracts';
import type { Hono, Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { MULTIPART_OVERHEAD_BYTES } from '../projects/routes.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { assetContent, blankPreview, checkBlankFile, checkPicture, orgAssetsState, removeAsset, saveBlank, saveDirector, savePicture, versionOf } from './assets.ts';
import { prepareBlank, type BlankDeps } from './blank.ts';
import { orgFilePaths } from './files.ts';
import { setSigners } from './signers.ts';

export interface OrgDocsRouteDeps {
  db: Db;
  // Where the letterhead and the logo are laid out for agents (core/org-docs/files.ts).
  filesDir: string;
  blank: BlankDeps;
}

const CACHE_FOR_GOOD = 'private, max-age=31536000, immutable';
const ONLY_SUPERADMIN = 'Печать, подпись и ответственных лиц задаёт только суперадминистратор.';

function kindOf(c: Context<AppEnv>): OrgAssetKind {
  const kind = c.req.param('kind');
  if (!ORG_ASSET_KINDS.includes(kind as OrgAssetKind)) throw appError('APP_NOT_FOUND', `no org asset ${kind}`);
  return kind as OrgAssetKind;
}

function assertSuperadmin(c: Context<AppEnv>, what: string): void {
  if (!access(c).isSuperadmin) throw appError('APP_ADMIN_FORBIDDEN', `${what} is for a superadmin`, { userMessage: ONLY_SUPERADMIN });
}

// A kind of the stamp and the signature asks a superadmin; the others are the right of the section.
function assertCanTouch(c: Context<AppEnv>, kind: OrgAssetKind): void {
  if (SUPERADMIN_ASSETS.has(kind)) assertSuperadmin(c, `org asset ${kind}`);
}

export function registerOrgDocsRoutes(app: Hono<AppEnv>, deps: OrgDocsRouteDeps): void {
  const right = requirePermission('org_profile');
  const state = (c: Context<AppEnv>) => orgAssetsState(deps.db, { isSuperadmin: access(c).isSuperadmin });

  app.get('/app/api/admin/org-assets', right, async (c) => c.json(await state(c)));

  app.put(
    '/app/api/admin/org-assets/:kind',
    right,
    // Counts the bytes even without Content-Length, before the form is read into memory.
    bodyLimit({
      maxSize: ORG_BLANK_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: () => {
        throw appError('APP_ORG_BLANK_FORMAT', 'org asset form over the limit', { userMessage: 'Файл больше 5 МБ. Уберите из него крупные картинки и загрузите снова.' });
      },
    }),
    async (c) => {
      const kind = kindOf(c);
      assertCanTouch(c, kind);
      const file = (await c.req.parseBody()).file;
      if (!(file instanceof File)) throw appError('APP_VALIDATION_FAILED', 'file field is not a file', { userMessage: 'Файл не получен. Выберите его ещё раз.' });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const actor = access(c).userId;
      if (kind === 'blank') {
        checkBlankFile(file.name, bytes);
        await saveBlank(deps.db, actor, { fileName: file.name, bytes }, await prepareBlank(deps.blank, bytes));
      } else {
        await savePicture(deps.db, actor, kind, checkPicture(kind, bytes));
      }
      // Laid out now, so the first answer after the upload does not wait for it.
      await orgFilePaths(deps.db, deps.filesDir);
      return c.json(await state(c));
    },
  );

  app.delete('/app/api/admin/org-assets/:kind', right, async (c) => {
    const kind = kindOf(c);
    assertCanTouch(c, kind);
    await removeAsset(deps.db, access(c).userId, kind);
    return c.json(await state(c));
  });

  // The letterhead as uploaded (to download) or a picture (to show in the block).
  app.get('/app/api/admin/org-assets/:kind/file', right, async (c) => {
    const kind = kindOf(c);
    assertCanTouch(c, kind);
    const asset = await assetContent(deps.db, kind);
    if (!asset) throw appError('APP_NOT_FOUND', `no org asset ${kind} uploaded`);
    const current = c.req.query('v') === versionOf(asset.sha256);
    const headers: Record<string, string> = { 'Cache-Control': current ? CACHE_FOR_GOOD : 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (kind === 'blank') {
      headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(asset.fileName ?? 'blank.docx')}`;
    } else {
      headers['Content-Type'] = 'image/png';
    }
    return c.body(new Uint8Array(asset.bytes), 200, headers);
  });

  // «Так начнётся документ агента»: the PDF of the copy without text.
  app.get('/app/api/admin/org-assets/blank/preview', right, async (c) => {
    const preview = await blankPreview(deps.db);
    if (!preview) throw appError('APP_NOT_FOUND', 'no letterhead uploaded');
    return c.body(new Uint8Array(preview.bytes), 200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  });

  app.put('/app/api/admin/org-director', right, async (c) => {
    const parsed = orgDirectorSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const fullName = parsed.error.issues.some((i) => i.path[0] === 'fullName');
      throw appError('APP_VALIDATION_FAILED', `bad director: ${parsed.error.message}`, fullName ? { userMessage: 'Укажите ФИО полностью: фамилия, имя, отчество (если есть).' } : {});
    }
    await saveDirector(deps.db, access(c).userId, parsed.data);
    return c.json(await state(c));
  });

  app.put('/app/api/admin/org-signers', right, async (c) => {
    assertSuperadmin(c, 'the list of responsible people');
    const { userIds } = await parseJson(c, orgSignersSchema);
    await setSigners(deps.db, access(c).userId, userIds);
    return c.json(await state(c));
  });
}
