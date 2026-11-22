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
import { loadAccess } from '../auth/access.ts';
import type { AgentAbilities } from '@bba/contracts';
import { contextRoot, draftsPath, DRAFTS_KEEP_DAYS, listFiles } from '../workspace/layout.ts';
import { WIDGETS_OFF, widgetsRules } from '../widgets/prompt.ts';
import { readableTitles } from '../knowledge/store.ts';

export const BASE_RULES = readFileSync(new URL('./base-rules.md', import.meta.url), 'utf8');
// What the agent may do (spec, section 8.30): the rules of programs only to the agent that may run them; the
// others are told plainly what is switched off, so they say so instead of trying.
const COMMANDS_TEMPLATE = readFileSync(new URL('./rules-commands.md', import.meta.url), 'utf8');
// The rules of programs name the drafts folder of the conversation (spec, section 8.33): the same every turn of it.
export function commandsRules(drafts: string): string {
  return COMMANDS_TEMPLATE.replaceAll('{{drafts}}', drafts).replaceAll('{{days}}', String(DRAFTS_KEEP_DAYS)).trim();
}
const SWITCHED_OFF = 'выключен в настройках агента';
export const COMMANDS_OFF = `Запуск программ тебе ${SWITCHED_OFF}: скрипты и программы ты не запускаешь, файлы Word, Excel, PowerPoint и PDF не создаёшь и не правишь, архивы не распаковываешь, документ дальше показанного фрагмента не дочитываешь. Если сотруднику нужно это — скажи, что запуск программ ${SWITCHED_OFF}, и сделай, что можешь, текстом.`;
// What the model's own knowledge gets wrong by its age: checked on the internet, or named as unchecked without it.
const CHANGEABLE = 'курсы и цены, законы, налоги, пошлины, штрафы, пороги и сроки по законам, тарифы, требования ведомств, кто руководит организацией, новости';
export const WEB_RULES = [
  '## Интернет',
  '- Свежие сведения из интернета и чтение страниц по ссылкам — через `web_research`: опиши задание полностью (что найти, ссылки, в каком виде вернуть) — исследователь не видит этот разговор.',
  '- В ответе называй источники ссылками.',
  '- Не ищи в интернете то, что есть в документах, памяти и подключённых системах.',
  `- Изменчивое — ${CHANGEABLE} — по своей памяти не называй как действующее. Если сотрудник спрашивает именно об этом или на этом значении стоит расчёт, который он просил, сверь через \`web_research\` сразу, не спрашивая разрешения: все такие значения ответа — одним заданием, уже проверенное в этом разговоре не перепроверяй. Назови источник и дату, на которую он это даёт, если источник её называет («по данным ЦБ на 3 октября»); проверенное не сопровождай оговорками «уточните сами». Упоминаешь мимоходом — отметь одной фразой, что не проверял и это могло измениться.`,
  '- В задание исследователю клади только то, что нужно для поиска: название, ИНН и ОГРН организации или ИП, которую нужно проверить, — можно; переписку, внутренние документы организации и данные людей, не нужные для поиска, — нет. Человека из разговора не отождествляй с однофамильцем из поиска.',
].join('\n');
export const WEB_OFF = `Интернета у тебя нет — он ${SWITCHED_OFF}. Изменчивое — ${CHANGEABLE} — по своей памяти называй только с пометкой одной фразой: не проверено, могло измениться. Если нужны свежие сведения из интернета, скажи сотруднику, что интернет ${SWITCHED_OFF}.`;

// The block of what the agent may do: it changes only with the switches, so the system prompt stays the same
// from turn to turn.
// An agent whose passport turns the core's rules off (baseRules: false) gets no rules of programs either — they
// were a part of the core's rules; what is switched off it is told still.
// Widgets (spec, section 8.31) are only the agent's the person talks to: a sub-agent is told nothing about them.
// `drafts` — the drafts folder of the conversation, asked only when the rules of programs are given.
export function abilitiesLayer(abilities: AgentAbilities, baseRules: boolean, level: 'top' | 'sub', drafts: () => string): string {
  const commands = abilities.commands ? (baseRules ? commandsRules(drafts()) : null) : COMMANDS_OFF;
  const widgets = level === 'top' ? (abilities.widgets ? widgetsRules() : WIDGETS_OFF) : null;
  return [commands, abilities.web ? WEB_RULES : WEB_OFF, widgets].filter((part): part is string => part !== null).join('\n\n');
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
  // Every agent of the installation: the one the person talks to names the others open to them, to send a question
  // outside its role there (the core's rules, «Твоя роль»).
  agents: () => readonly AgentCard[];
}

export interface AgentCard {
  id: string;
  name: string;
  description: string;
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

// The other agents the person may open (the superadmin — every one), where the agent sends a question outside its
// role. None open — no layer: a person unknown to the directory has no department, so no agent either.
// The knowledge base the person reads: up to PROMPT_KNOWLEDGE_TITLES names of documents and how many more; none — no layer.
export const PROMPT_KNOWLEDGE_TITLES = 100;
export async function knowledgeLayer(db: Db, userId: string): Promise<string | null> {
  const { titles, total } = await readableTitles(db, userId, PROMPT_KNOWLEDGE_TITLES);
  if (total === 0) return null;
  const more = total > titles.length ? `\nи ещё ${total - titles.length}` : '';
  return `# База знаний организации\nДокументы, по которым отвечаешь на вопросы о компании (ищи в них инструментом knowledge_search):\n${titles.map((t) => `- ${t}`).join('\n')}${more}`;
}

export async function otherAgentsLayer(db: Db, userId: string, agentId: string, agents: readonly AgentCard[]): Promise<string | null> {
  const access = await loadAccess(db, userId);
  const open = agents.filter((a) => a.id !== agentId && (access?.isSuperadmin || access?.agentIds.has(a.id)));
  if (open.length === 0) return null;
  return [
    '# Другие агенты сотрудника',
    'К ним сотрудник переходит сам — выбирает агента по названию в шапке чата. Там начнётся новый разговор: этот разговор и его файлы другой агент не увидит — суть и файлы сотрудник передаст ему сам.',
    ...open.map((a) => `- «${a.name}» — ${a.description}`),
  ].join('\n');
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
      const [org, employee, others, project, knowledge] = await Promise.all([
        organisationLayer(deps.db),
        employeeLayer(deps.db, userId),
        // A sub-agent answers the agent that called it, not the person: it sends nobody anywhere. Without the core's
        // rules no rule asks for the list.
        deps.level === 'top' && deps.baseRules ? otherAgentsLayer(deps.db, userId, deps.agentId, deps.agents()) : Promise.resolve(null),
        projectId
          ? projectLayer(deps.db, deps.workspaceRoot, userId, requireContextValue(requestContext, REQUEST_KEYS.projectOwnerId), projectId, projectMemory ? projectMemoryText(projectMemory, deps.timezone) : null, conversations)
          : Promise.resolve(lost ? lostProjectLayer(JSON.parse(lost) as { name: string; reason: LostProjectReason }) : null),
        // The documents of the knowledge base the person reads (docs/specs/[20.11.2026]-knowledge-base.md, section 7).
        knowledgeLayer(deps.db, userId),
      ]);
      return {
        messages,
        systemMessages: [
          ...(deps.baseRules ? [{ role: 'system' as const, content: BASE_RULES }] : []),
          {
            role: 'system' as const,
            content: abilitiesLayer(abilitiesOf(requestContext), deps.baseRules, deps.level, () => draftsPath(requireContextValue(requestContext, REQUEST_KEYS.threadId), projectId !== null)),
          },
          ...systemMessages,
          { role: 'system' as const, content: org },
          { role: 'system' as const, content: employee },
          ...(others ? [{ role: 'system' as const, content: others }] : []),
          ...(project ? [{ role: 'system' as const, content: project }] : []),
          ...(knowledge ? [{ role: 'system' as const, content: knowledge }] : []),
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
