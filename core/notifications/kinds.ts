// The kinds of notifications and their texts (docs/specs/[20.11.2026]-notifications.md, sections 8 and 12). A notice names
// only what it is about — an action, a task, a system, a project, a conversation — never its content: a push passes
// through Google, Apple or Mozilla (encrypted) and stays on a locked screen.
import type { NotificationKind } from '@bba/contracts';

export interface Notice {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  // One notification per case: the same case reported again writes nothing.
  dedupKey: string;
  // What it is about, to tell "already decided" when it is delivered later (quiet hours).
  subjectRef: string | null;
  // The conversation it is about: opening it marks the notification read.
  threadId: string | null;
}

// How long the push service keeps an undelivered push (a phone switched off), and how urgently it wakes the device.
export const PUSH_DELIVERY: Record<NotificationKind, { ttlSeconds: number; urgency: 'normal' | 'high' }> = {
  approval_waiting: { ttlSeconds: 12 * 3600, urgency: 'high' },
  approval_expiring: { ttlSeconds: 12 * 3600, urgency: 'high' },
  connection_broken: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  task_result: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  task_failed: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  project_shared: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  limit_near: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  limit_exhausted: { ttlSeconds: 12 * 3600, urgency: 'normal' },
  answer_ready: { ttlSeconds: 3600, urgency: 'normal' },
  answer_failed: { ttlSeconds: 3600, urgency: 'normal' },
};

const TITLE_MAX = 200;
const BODY_MAX = 300;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function notice(input: Notice): Notice {
  return { ...input, title: clip(input.title, TITLE_MAX), body: clip(input.body, BODY_MAX) };
}

export const threadLink = (agentId: string, threadId: string) => `/agents/${encodeURIComponent(agentId)}?thread=${encodeURIComponent(threadId)}`;
// Questions of background tasks are answered on «Ждёт подтверждения»; the link opens it on this question.
export const questionLink = (approvalId: string) => `/approvals?question=${encodeURIComponent(approvalId)}`;
export const approvalRef = (approvalId: string) => `approval:${approvalId}`;

// Where the question came from, for the line under the title.
export type QuestionOrigin = { kind: 'task'; taskTitle: string } | { kind: 'conversation'; agentId: string; threadId: string; threadTitle: string };

function questionPlace(input: { approvalId: string; origin: QuestionOrigin }): Pick<Notice, 'link' | 'threadId'> {
  return input.origin.kind === 'task'
    ? { link: questionLink(input.approvalId), threadId: null }
    : { link: threadLink(input.origin.agentId, input.origin.threadId), threadId: input.origin.threadId };
}

const originName = (origin: QuestionOrigin) => (origin.kind === 'task' ? origin.taskTitle : `Разговор «${origin.threadTitle}»`);

export const notices = {
  approvalWaiting(input: { userId: string; approvalId: string; action: string; origin: QuestionOrigin }): Notice {
    return notice({
      userId: input.userId,
      kind: 'approval_waiting',
      title: 'Ждёт вашего решения',
      body: `${originName(input.origin)} · ${input.action}`,
      ...questionPlace(input),
      dedupKey: `approval:${input.approvalId}`,
      subjectRef: approvalRef(input.approvalId),
    });
  },

  // When a quarter of the question's term is left (decision of the agent, section 15).
  approvalExpiring(input: { userId: string; approvalId: string; action: string; origin: QuestionOrigin; hoursLeft: number }): Notice {
    return notice({
      userId: input.userId,
      kind: 'approval_expiring',
      title: `Вопрос сгорит через ${input.hoursLeft} ч`,
      body: `${originName(input.origin)} · ${input.action}`,
      ...questionPlace(input),
      dedupKey: `approval_expiring:${input.approvalId}`,
      subjectRef: approvalRef(input.approvalId),
    });
  },

  // `connectionKey` — 'connector:<id>' or 'mail:<id>'; `brokenAt` makes each breakage its own case.
  connectionBroken(input: { userId: string; connectionKey: string; title: string; brokenAt: Date }): Notice {
    return notice({
      userId: input.userId,
      kind: 'connection_broken',
      title: `Не работает доступ к ${input.title}`,
      body: 'Агент не может работать с ней от вашего имени. Подключитесь заново в «Настройки → Подключения».',
      link: '/settings/connections',
      dedupKey: `connection_broken:${input.connectionKey}:${input.brokenAt.getTime()}`,
      subjectRef: `connection:${input.connectionKey}`,
      threadId: null,
    });
  },

  taskResult(input: { userId: string; runId: string; taskId: string; taskTitle: string; agentId: string }): Notice {
    const threadId = `bg:${input.taskId}:${input.userId}`;
    return notice({
      userId: input.userId,
      kind: 'task_result',
      title: `Готово: ${input.taskTitle}`,
      body: 'Результат — в разговоре задачи.',
      link: threadLink(input.agentId, threadId),
      dedupKey: `task_result:${input.runId}`,
      subjectRef: `run:${input.runId}`,
      threadId,
    });
  },

  taskFailed(input: { userId: string; runId: string; taskId: string; taskTitle: string; agentId: string }): Notice {
    const threadId = `bg:${input.taskId}:${input.userId}`;
    return notice({
      userId: input.userId,
      kind: 'task_failed',
      title: `Задача не выполнена: ${input.taskTitle}`,
      body: 'Что случилось — в разговоре задачи и на «Ждёт подтверждения» в «Не получилось».',
      link: threadLink(input.agentId, threadId),
      dedupKey: `task_failed:${input.runId}`,
      subjectRef: `run:${input.runId}`,
      threadId,
    });
  },

  // `sharedAt` makes each opening its own case: a project closed and opened again tells again.
  projectShared(input: { userId: string; projectId: string; projectName: string; ownerName: string; sharedAt: Date }): Notice {
    return notice({
      userId: input.userId,
      kind: 'project_shared',
      title: `Вам открыли проект «${input.projectName}»`,
      body: `Проект ведёт ${input.ownerName}. Он уже в списке «Проекты».`,
      link: `/projects/${encodeURIComponent(input.projectId)}`,
      dedupKey: `project_shared:${input.projectId}:${input.sharedAt.getTime()}`,
      subjectRef: `project:${input.projectId}`,
      threadId: null,
    });
  },

  // `month` — 'YYYY-MM' in the time zone of the installation: one notice of each kind per month.
  limitNear(input: { userId: string; month: string; percent: number; spentRub: number; limitRub: number }): Notice {
    return notice({
      userId: input.userId,
      kind: 'limit_near',
      title: `Израсходовано ${input.percent} % лимита на ${monthName(input.month)}`,
      body: `Потрачено ${rub(input.spentRub)} из ${rub(input.limitRub)}. Когда лимит кончится, агенты не ответят до нового месяца.`,
      link: '/settings/usage',
      dedupKey: `limit_near:${input.month}`,
      subjectRef: null,
      threadId: null,
    });
  },

  limitExhausted(input: { userId: string; month: string; limitRub: number }): Notice {
    return notice({
      userId: input.userId,
      kind: 'limit_exhausted',
      title: `Лимит на ${monthName(input.month)} исчерпан`,
      body: `Израсходовано ${rub(input.limitRub)}. Агенты не ответят до нового месяца, если администратор не поднимет лимит.`,
      link: '/settings/usage',
      dedupKey: `limit_exhausted:${input.month}`,
      subjectRef: null,
      threadId: null,
    });
  },

  // The person left before the answer ended (their browser's stream closed while the agent worked).
  answerReady(input: { userId: string; runKey: string; agentId: string; threadId: string; threadTitle: string }): Notice {
    return notice({
      userId: input.userId,
      kind: 'answer_ready',
      title: 'Ответ готов',
      body: `Разговор «${input.threadTitle}»`,
      link: threadLink(input.agentId, input.threadId),
      dedupKey: `answer_ready:${input.runKey}`,
      subjectRef: null,
      threadId: input.threadId,
    });
  },

  answerFailed(input: { userId: string; runKey: string; agentId: string; threadId: string; threadTitle: string }): Notice {
    return notice({
      userId: input.userId,
      kind: 'answer_failed',
      title: 'Ответ не получился',
      body: `Разговор «${input.threadTitle}». Откройте его — там видно, что случилось, и можно ответить заново.`,
      link: threadLink(input.agentId, input.threadId),
      dedupKey: `answer_failed:${input.runKey}`,
      subjectRef: null,
      threadId: input.threadId,
    });
  },
};

function monthName(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTHS[index];
  if (!name) throw new Error(`APP_INTERNAL: "${month}" is not a month YYYY-MM`);
  return name;
}

const rub = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} ₽`;
