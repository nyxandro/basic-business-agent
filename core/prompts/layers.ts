// Dynamic prompt assembly (spec, section 8.3). The agent's own instructions (file or published
// Editor version) are the only layer edited in the admin panel; this processor adds the rest, from
// what never changes to what changes: core rules before them, then the organisation, the employee
// and the project of the conversation with its memory; the employee's personal memory goes last (spec, 8.26).
// The agent the person talks to in a conversation also gets the names of the person's past conversations of
// the project (spec, 8.28).
// The current time is not in the system prompt at all: a provider reuses only an unchanged beginning
// of a request, and a clock there would make the whole prompt and the conversation history after it
// new every minute. It is added to the person's last message of the outgoing request only
// (processLLMRequest), so the stored history never holds it.
import { readFileSync } from 'node:fs';
import type { Processor } from '@mastra/core/processors';
import type { LostProjectReason } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { hiddenMessagesNote, hiddenNoteOf, keepHiddenNote, pastConversationsText, PROMPT_CONVERSATIONS } from '../history/prompt.ts';
import { listConversations, storedMessageCount } from '../history/store.ts';
import { listEntries } from '../memory/entries.ts';
import { LAST_MESSAGES } from '../memory/memory.ts';
import { keepMemorySeen, personalMemoryText, projectMemoryText, seenVersions } from '../memory/prompt.ts';
import { SHARED } from '../projects/access.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue } from '../runtime/request-keys.ts';
import { abilitiesOf } from '../abilities/abilities.ts';
import type { AgentAbilities } from '@bba/contracts';
import { contextRoot, listFiles } from '../workspace/layout.ts';

export const BASE_RULES = readFileSync(new URL('./base-rules.md', import.meta.url), 'utf8');
// What the agent may do (spec, section 8.30): the rules of programs only to the agent that may run them; the
// others are told plainly what is switched off, so they say so instead of trying.
export const COMMANDS_RULES = readFileSync(new URL('./rules-commands.md', import.meta.url), 'utf8');
const SWITCHED_OFF = 'выключен в настройках агента';
export const COMMANDS_OFF = `Запуск программ тебе ${SWITCHED_OFF}: скрипты и программы ты не запускаешь, файлы Word, Excel, PowerPoint и PDF не создаёшь и не правишь, архивы не распаковываешь, документ дальше показанного фрагмента не дочитываешь. Если сотруднику нужно это — скажи, что запуск программ ${SWITCHED_OFF}, и сделай, что можешь, текстом.`;
export const WEB_RULES = `## Интернет\n- Свежие сведения из интернета и чтение страниц по ссылкам — через \`web_research\`: опиши задание полностью (что найти, ссылки, в каком виде вернуть) — исследователь не видит этот разговор.\n- В ответе называй источники ссылками.\n- Не ищи в интернете то, что есть в документах, памяти и подключённых системах.`;
export const WEB_OFF = `Интернета у тебя нет — он ${SWITCHED_OFF}. Если нужны свежие сведения из интернета, скажи об этом сотруднику; свои знания не выдавай за свежие.`;

// The block of what the agent may do: it changes only with the switches, so the system prompt stays the same
// from turn to turn.
export function abilitiesLayer(abilities: AgentAbilities): string {
  return [abilities.commands ? COMMANDS_RULES.trim() : COMMANDS_OFF, abilities.web ? WEB_RULES : WEB_OFF].join('\n\n');
}

export interface LayersDeps {
  db: Db;
  timezone: string;
  baseRules: boolean;
  workspaceRoot: string;
  // A sub-agent gets no past conversations: it has no tool to read them (spec, 8.28).
  level: 'top' | 'sub';
  // The agent whose prompt this is: a past conversation with another agent is named so.
  agentId: string;
  agentName: (id: string) => string;
}

// The model sees this many project files by name; it lists the folder itself when it needs more.
export const PROMPT_FILES_LIMIT = 100;

interface OrgRow {
  name: string | null;
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

export async function organisationLayer(db: Db): Promise<string> {
  const { rows } = await db.query<OrgRow>('SELECT name, tone, requisites, industry FROM app.org_profile');
  const org = rows[0];
  if (!org?.name) throw new Error('app.org_profile has no name: ensureOrgName runs at the start of the server');
  return lines('# Профиль организации', [
    ['Название', org.name],
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

// The project of the run: the run's entry point checked that the person sees it, so it is read by its
// id; its files live with its creator (spec, section 8.20). A project open to colleagues says so, and
// warns the agent off their files. `memory` — the project's memory as the prompt reads it (null in a draft check);
// `conversations` — the names of the person's past conversations in it (spec, 8.28; null where there are none).
export async function projectLayer(db: Db, workspaceRoot: string, viewerId: string, ownerId: string, projectId: string, memory: string | null, conversations: string | null = null): Promise<string | null> {
  const { rows } = await db.query<{ name: string; instructions: string; owner_name: string; shared: boolean }>(
    `SELECT p.name, p.instructions, u."name" AS owner_name, ${SHARED} AS shared
       FROM app.projects p JOIN app."user" u ON u."id" = p.user_id WHERE p.id = $1 AND p.user_id = $2`,
    [projectId, ownerId],
  );
  const project = rows[0];
  if (!project) return null;
  const files = listFiles(contextRoot(workspaceRoot, ownerId, projectId));
  const shown = files.slice(0, PROMPT_FILES_LIMIT).map((f) => `- ${f.path} (${sizeText(f.bytes)})`);
  const more = files.length > PROMPT_FILES_LIMIT ? [`- и ещё ${files.length - PROMPT_FILES_LIMIT}`] : [];
  const shared = !project.shared
    ? null
    : viewerId === ownerId
      ? 'Проект открыт коллегам: его файлы видят и меняют и они.'
      : `Проект общий, его открыл(а) тебе ${project.owner_name}. Файлы проекта видят и меняют коллеги: не удаляй и не перезаписывай файлы, которые сотрудник прямо не просил менять; новый результат сохраняй новым файлом.`;
  return [
    `# Проект «${project.name}»`,
    shared,
    project.instructions.trim() || null,
    memory,
    conversations,
    files.length > 0 ? ['Файлы проекта лежат в твоей рабочей папке:', ...shown, ...more].join('\n') : 'Файлов в проекте пока нет.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const LOST_PROJECT_WHY: Record<LostProjectReason, string> = {
  access: 'доступ к нему закрыт',
  archived: 'проект перенесён в архив',
  deleted: 'проект удалён',
};

// The conversation's project is gone for the person: the agent hears why from the person's side.
export function lostProjectLayer(lost: { name: string; reason: LostProjectReason }): string {
  return `# Проект разговора недоступен\n\nЭтот разговор был в проекте «${lost.name}», но ${LOST_PROJECT_WHY[lost.reason]}. Файлов и инструкций проекта у тебя больше нет. Если сотрудник просит работать с ними — объясни это и предложи прислать нужные файлы в разговор.`;
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
      const lost = optionalContextValue(requestContext, REQUEST_KEYS.lostProject);
      // A draft check of a prompt neither reads nor writes anyone's memory (spec, 8.26).
      const withMemory = optionalContextValue(requestContext, REQUEST_KEYS.runKind) !== 'draft';
      const [projectMemory, personalMemory] = withMemory
        ? await Promise.all([projectId ? listEntries(deps.db, { kind: 'project', projectId }) : Promise.resolve(null), listEntries(deps.db, { kind: 'personal', userId })])
        : [null, null];
      if (personalMemory && requestContext) keepMemorySeen(requestContext, { project: projectMemory ? seenVersions(projectMemory) : null, personal: seenVersions(personalMemory) });
      // Past conversations only where the agent has the tool to read them: the one the person talks to, in a chat.
      const withHistory = deps.level === 'top' && optionalContextValue(requestContext, REQUEST_KEYS.runKind) === 'chat';
      const threadId = withHistory ? requireContextValue(requestContext, REQUEST_KEYS.threadId) : null;
      const [past, stored] = threadId
        ? await Promise.all([
            projectId ? listConversations(deps.db, userId, { projectId, exclude: threadId, limit: PROMPT_CONVERSATIONS, offset: 0 }) : Promise.resolve(null),
            storedMessageCount(deps.db, threadId),
          ])
        : [null, 0];
      if (threadId && requestContext) keepHiddenNote(requestContext, hiddenMessagesNote(stored, LAST_MESSAGES));
      const conversations = past ? pastConversationsText(past, { currentAgentId: deps.agentId, agentName: deps.agentName, timezone: deps.timezone }) : null;
      const [org, employee, project] = await Promise.all([
        organisationLayer(deps.db),
        employeeLayer(deps.db, userId),
        projectId
          ? projectLayer(deps.db, deps.workspaceRoot, userId, requireContextValue(requestContext, REQUEST_KEYS.projectOwnerId), projectId, projectMemory ? projectMemoryText(projectMemory, deps.timezone) : null, conversations)
          : Promise.resolve(lost ? lostProjectLayer(JSON.parse(lost) as { name: string; reason: LostProjectReason }) : null),
      ]);
      return {
        messages,
        systemMessages: [
          ...(deps.baseRules ? [{ role: 'system' as const, content: BASE_RULES }] : []),
          { role: 'system' as const, content: abilitiesLayer(abilitiesOf(requestContext)) },
          ...systemMessages,
          { role: 'system' as const, content: org },
          { role: 'system' as const, content: employee },
          ...(project ? [{ role: 'system' as const, content: project }] : []),
          ...(personalMemory ? [{ role: 'system' as const, content: personalMemoryText(personalMemory, deps.timezone) }] : []),
        ],
      };
    },

    processLLMRequest({ prompt, requestContext }) {
      const last = prompt.findLastIndex((m) => m.role === 'user');
      if (last < 0) return undefined;
      const message = prompt[last]!;
      if (message.role !== 'user') return undefined;
      // Which first messages of a long conversation the model does not see (spec, 8.28): the number grows every
      // turn, so it goes here, with the time, not into the system prompt. A sub-agent shares the run's context
      // but has no tool to read the conversation.
      const hidden = deps.level === 'top' ? hiddenNoteOf(requestContext) : null;
      const stamped = { ...message, content: [...message.content, { type: 'text' as const, text: `\n\n(${timeLayer(deps.timezone)})${hidden ? `\n(${hidden})` : ''}` }] };
      return { prompt: prompt.map((m, i) => (i === last ? stamped : m)) };
    },
  } satisfies Processor;
}
