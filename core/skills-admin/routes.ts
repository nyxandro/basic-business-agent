// «Скиллы» in the admin panel (spec, scenario 10, section 17.5). Needs the "skills" right.
// POST with ?check=1 only reads the file and shows what is inside; without it the skill is saved.
// PUT takes a new `.skill` file (replace the version) or JSON (switch, change who gets it).
import { skillAccessSchema, skillUpdateSchema } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { ARCHIVE_MAX_BYTES } from './archive.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { MULTIPART_OVERHEAD_BYTES } from '../projects/routes.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { createSkill, deleteSkill, listSkills, previewSkill, replaceSkill, updateSkill, type SkillsDeps } from './store.ts';

async function upload(c: Context<AppEnv>): Promise<{ archive: Uint8Array; fields: Record<string, unknown> }> {
  if (Number(c.req.header('content-length') ?? 0) > ARCHIVE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new AppError({ code: 'APP_SKILL_INVALID', message: 'skill upload over the limit', userMessage: `Файл скилла не подходит: файл больше ${ARCHIVE_MAX_BYTES / 1024 / 1024} МБ.`, status: 413 });
  }
  const fields = await c.req.parseBody();
  const file = fields.file;
  if (!(file instanceof File)) throw appError('APP_VALIDATION_FAILED', 'no file field', { userMessage: 'Файл не получен. Выберите файл .skill ещё раз.' });
  return { archive: new Uint8Array(await file.arrayBuffer()), fields };
}

function accessField(raw: unknown) {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch (error) {
    throw appError('APP_VALIDATION_FAILED', 'access field is not JSON', { cause: error, userMessage: 'Укажите, кому доступен скилл.' });
  }
  const parsed = skillAccessSchema.safeParse(value);
  if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad access field: ${parsed.error.message}`, { userMessage: 'Укажите, кому доступен скилл.' });
  return parsed.data;
}

export function registerSkillRoutes(app: Hono<AppEnv>, deps: SkillsDeps): void {
  const skills = requirePermission('skills');

  app.get('/app/api/admin/skills', skills, async (c) => c.json(await listSkills(deps)));

  app.post('/app/api/admin/skills', skills, async (c) => {
    const { archive, fields } = await upload(c);
    if (c.req.query('check') === '1') return c.json(await previewSkill(deps, archive));
    return c.json(await createSkill(deps, access(c).userId, archive, accessField(fields.access)), 201);
  });

  app.put('/app/api/admin/skills/:name', skills, async (c) => {
    const name = c.req.param('name');
    if ((c.req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const { archive } = await upload(c);
      return c.json(await replaceSkill(deps, access(c).userId, name, archive));
    }
    return c.json(await updateSkill(deps, access(c).userId, name, await parseJson(c, skillUpdateSchema)));
  });

  app.delete('/app/api/admin/skills/:name', skills, async (c) => {
    await deleteSkill(deps, access(c).userId, c.req.param('name'));
    return c.json({ ok: true });
  });
}
