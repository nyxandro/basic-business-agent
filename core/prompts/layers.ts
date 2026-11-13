// Dynamic prompt assembly (spec, section 8.3). The agent's own instructions (file or published
// Editor version) are the only layer edited in the admin panel; this processor adds the rest:
// core rules before them, then the organisation profile and the employee profile after them.
// Personal memory is added by Mastra itself.
import { readFileSync } from 'node:fs';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { REQUEST_KEYS, requireContextValue } from '../runtime/request-keys.ts';

export const BASE_RULES = readFileSync(new URL('./base-rules.md', import.meta.url), 'utf8');

export interface LayersDeps {
  db: Db;
  organisationName: string;
  timezone: string;
  baseRules: boolean;
}

interface OrgRow {
  tone: string;
  requisites: string;
  industry: string;
}

interface UserRow {
  name: string;
  position: string | null;
  departments: string[] | null;
}

function lines(title: string, pairs: [string, string | null | undefined][]): string | null {
  const filled = pairs.filter(([, v]) => v && v.trim() !== '').map(([k, v]) => `${k}: ${v!.trim()}`);
  return filled.length > 0 ? `${title}\n${filled.join('\n')}` : null;
}

export async function organisationLayer(db: Db, organisationName: string): Promise<string> {
  const { rows } = await db.query<OrgRow>('SELECT tone, requisites, industry FROM app.org_profile');
  const org = rows[0];
  return lines('# Профиль организации', [
    ['Название', organisationName],
    ['Отрасль', org?.industry],
    ['Тон общения', org?.tone],
    ['Реквизиты', org?.requisites],
  ])!;
}

export async function employeeLayer(db: Db, userId: string, timezone: string, now = new Date()): Promise<string> {
  const { rows } = await db.query<UserRow>(
    `SELECT u."name" AS name, p.position,
            (SELECT array_agg(d.name ORDER BY d.name) FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = u."id") AS departments
       FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id" WHERE u."id" = $1`,
    [userId],
  );
  const user = rows[0];
  const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(now);
  return lines('# Сотрудник, с которым ты говоришь', [
    ['Имя', user?.name],
    ['Должность', user?.position],
    ['Отделы', user?.departments?.join(', ')],
    ['Сейчас', `${date} (${timezone})`],
  ])!;
}

export function createPromptLayersProcessor(deps: LayersDeps) {
  return {
    id: 'bba-prompt-layers',
    async processInput({ messages, systemMessages, requestContext }) {
      const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
      const [org, employee] = await Promise.all([organisationLayer(deps.db, deps.organisationName), employeeLayer(deps.db, userId, deps.timezone)]);
      return {
        messages,
        systemMessages: [
          ...(deps.baseRules ? [{ role: 'system' as const, content: BASE_RULES }] : []),
          ...systemMessages,
          { role: 'system' as const, content: org },
          { role: 'system' as const, content: employee },
        ],
      };
    },
  } satisfies Processor;
}
