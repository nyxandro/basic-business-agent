// Dynamic prompt assembly (spec, section 8.3). The agent's own instructions (file or published
// Editor version) are the only layer edited in the admin panel; this processor adds the rest, from
// what never changes to what changes: core rules before them, then the organisation, the employee
// and the project of the conversation. Personal memory is added by Mastra itself, after them.
// The current time is not in the system prompt at all: a provider reuses only an unchanged beginning
// of a request, and a clock there would make the whole prompt and the conversation history after it
// new every minute. It is added to the person's last message of the outgoing request only
// (processLLMRequest), so the stored history never holds it.
import { readFileSync } from 'node:fs';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue } from '../runtime/request-keys.ts';
import { contextRoot, listFiles } from '../workspace/layout.ts';

export const BASE_RULES = readFileSync(new URL('./base-rules.md', import.meta.url), 'utf8');

export interface LayersDeps {
  db: Db;
  organisationName: string;
  timezone: string;
  baseRules: boolean;
  workspaceRoot: string;
}

// The model sees this many project files by name; it lists the folder itself when it needs more.
export const PROMPT_FILES_LIMIT = 100;

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

export async function employeeLayer(db: Db, userId: string): Promise<string> {
  const { rows } = await db.query<UserRow>(
    `SELECT u."name" AS name, p.position,
            (SELECT array_agg(d.name ORDER BY d.name) FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = u."id") AS departments
       FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id" WHERE u."id" = $1`,
    [userId],
  );
  const user = rows[0];
  return lines('# Сотрудник, с которым ты говоришь', [
    ['Имя', user?.name],
    ['Должность', user?.position],
    ['Отделы', user?.departments?.join(', ')],
  ])!;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

export async function projectLayer(db: Db, workspaceRoot: string, userId: string, projectId: string): Promise<string | null> {
  const { rows } = await db.query<{ name: string; instructions: string }>('SELECT name, instructions FROM app.projects WHERE id = $1 AND user_id = $2', [projectId, userId]);
  const project = rows[0];
  if (!project) return null;
  const files = listFiles(contextRoot(workspaceRoot, userId, projectId));
  const shown = files.slice(0, PROMPT_FILES_LIMIT).map((f) => `- ${f.path} (${sizeText(f.bytes)})`);
  const more = files.length > PROMPT_FILES_LIMIT ? [`- и ещё ${files.length - PROMPT_FILES_LIMIT}`] : [];
  return [
    `# Проект «${project.name}»`,
    project.instructions.trim() || null,
    files.length > 0 ? ['Файлы проекта лежат в твоей рабочей папке:', ...shown, ...more].join('\n') : 'Файлов в проекте пока нет.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function timeLayer(timezone: string, now = new Date()): string {
  const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(now);
  return `Сейчас: ${date} (${timezone})`;
}

export function createPromptLayersProcessor(deps: LayersDeps) {
  return {
    id: 'bba-prompt-layers',
    async processInput({ messages, systemMessages, requestContext }) {
      const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
      const projectId = optionalContextValue(requestContext, REQUEST_KEYS.projectId);
      const [org, employee, project] = await Promise.all([
        organisationLayer(deps.db, deps.organisationName),
        employeeLayer(deps.db, userId),
        projectId ? projectLayer(deps.db, deps.workspaceRoot, userId, projectId) : Promise.resolve(null),
      ]);
      return {
        messages,
        systemMessages: [
          ...(deps.baseRules ? [{ role: 'system' as const, content: BASE_RULES }] : []),
          ...systemMessages,
          { role: 'system' as const, content: org },
          { role: 'system' as const, content: employee },
          ...(project ? [{ role: 'system' as const, content: project }] : []),
        ],
      };
    },

    processLLMRequest({ prompt }) {
      const last = prompt.findLastIndex((m) => m.role === 'user');
      if (last < 0) return undefined;
      const message = prompt[last]!;
      if (message.role !== 'user') return undefined;
      const stamped = { ...message, content: [...message.content, { type: 'text' as const, text: `\n\n(${timeLayer(deps.timezone)})` }] };
      return { prompt: prompt.map((m, i) => (i === last ? stamped : m)) };
    },
  } satisfies Processor;
}
