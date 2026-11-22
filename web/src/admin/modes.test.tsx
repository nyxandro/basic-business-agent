import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['agents'] };
const SALES_DEP = '00000000-0000-4000-8000-0000000000d1';
const AGENTS = [{ id: 'sales', name: 'Продажи', description: '', modelId: null, departmentNames: ['Отдел продаж'], starters: [], startersCustom: false, promptChanged: false }];
const COUNTS = { queued: 0, running: 0, done: 7, 'awaiting-approval': 0, failed: 0, skipped: 1 };
const TASK = {
  id: 't1',
  title: 'Утренняя сводка',
  agentId: 'sales',
  trigger: 'schedule',
  mailFilter: null,
  executor: null,
  hookUrl: null,
  events: null,
  access: { scope: 'departments', departmentIds: [SALES_DEP], userIds: [] },
  schedule: { kind: 'weekdays', time: '09:00' },
  cron: '0 9 * * 1-5',
  prompt: 'Сводка по сделкам',
  status: 'active',
  pausedReason: null,
  createdBy: 'Игорь',
  lastFire: { fireAt: '2026-11-14T06:00:00Z', total: 8, counts: COUNTS },
};

function server(tasks: object[] = [TASK]) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/tasks': { body: { tasks } },
    'GET /app/api/admin/agents': { body: { agents: AGENTS, missingAgents: [] } },
    'GET /app/api/admin/departments': { body: { departments: [{ id: SALES_DEP, name: 'Отдел продаж', userIds: [], agentIds: ['sales'], headIds: [] }] } },
    'GET /app/api/admin/people': { body: { people: [] } },
    'GET /app/api/admin/approval-settings': { body: { chatTtlHours: 24, backgroundTtlHours: 72 } },
  });
}

describe('«Режимы работы»', () => {
  // docs/specs/[20.11.2026]-notifications.md, F4: how long a question «Да» waits.
  it('sets how long a question «Да» waits, from 1 to 720 hours', async () => {
    const s = server();
    s.set('PUT /app/api/admin/approval-settings', (call) => ({ body: call.body }));
    renderApp('/admin/modes');
    const chat = await screen.findByRole('textbox', { name: 'Вопрос из разговора, часов' });
    const background = screen.getByRole('textbox', { name: 'Вопрос фоновой задачи, часов' });
    expect(chat).toHaveValue('24');
    expect(background).toHaveValue('72');
    const user = userEvent.setup();
    await user.clear(chat);
    await user.type(chat, '0');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Срок — от 1 до 720 часов')).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.clear(chat);
    await user.type(chat, '12');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ chatTtlHours: 12, backgroundTtlHours: 72 }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
  });

  it('shows a task with its schedule, area and «Выполнено у 7 из 8», and the breakdown by people', async () => {
    const s = server();
    s.set('GET /app/api/admin/tasks/t1/runs', {
      body: {
        fireAt: '2026-11-14T06:00:00Z',
        runs: [
          { userId: 'u1', name: 'Ольга Смирнова', outcome: 'done', reasonCode: null, startedAt: null, finishedAt: null },
          { userId: 'u2', name: 'Егор Гусев', outcome: 'skipped', reasonCode: 'blocked', startedAt: null, finishedAt: null },
        ],
      },
    });
    renderApp('/admin/modes');
    const row = (await screen.findByText('Утренняя сводка')).closest('tr')!;
    expect(within(row).getByText('По будням в 09:00')).toBeInTheDocument();
    expect(within(row).getByText('Отделы: Отдел продаж')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Выполнено у 7 из 8' }));
    const dialog = screen.getByRole('dialog', { name: 'Разбивка: Утренняя сводка' });
    expect(await within(dialog).findByText('Выполнено')).toBeInTheDocument();
    expect(within(dialog).getByText('Пропущено: сотрудник заблокирован')).toBeInTheDocument();
  });

  it('creates a task for «Отдел продаж» on a schedule', async () => {
    const s = server([]);
    s.set('POST /app/api/admin/tasks', { status: 201, body: TASK });
    renderApp('/admin/modes');
    const user = userEvent.setup();
    expect(await screen.findByText('Фоновых задач пока нет')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Новая задача' }));
    const dialog = screen.getByRole('dialog', { name: 'Новая задача' });
    await user.type(within(dialog).getByLabelText('Название'), 'Утренняя сводка');
    await user.click(within(dialog).getByRole('button', { name: 'Отделы' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Отдел продаж' }));
    await user.click(within(dialog).getByRole('button', { name: 'Раз в неделю' }));
    await user.selectOptions(within(dialog).getByLabelText('День недели'), 'пятница');
    await user.type(within(dialog).getByLabelText('Что сделать агенту'), 'Сводка по сделкам');
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    expect(await screen.findByText('Задача создана')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({
      title: 'Утренняя сводка',
      agentId: 'sales',
      trigger: 'schedule',
      access: { scope: 'departments', departmentIds: [SALES_DEP], userIds: [] },
      schedule: { kind: 'weekly', time: '09:00', weekday: 5 },
      prompt: 'Сводка по сделкам',
    });
  });

  // docs/specs/[20.11.2026]-event-tasks.md: a task on a message of another system — its executor, then its address.
  it('creates a task on a message of another system and shows its address to copy', async () => {
    const s = server([]);
    const HOOK = { ...TASK, id: 't2', title: 'Новая сделка', trigger: 'webhook', schedule: null, cron: null, access: { scope: 'users', departmentIds: [], userIds: ['u-olga'] }, executor: { id: 'u-olga', name: 'Ольга' }, hookUrl: 'http://localhost:8080/app/api/hooks/s3cret', events: { fired: 0, skipped: 0 }, lastFire: null };
    s.set('POST /app/api/admin/tasks', { status: 201, body: HOOK });
    s.set('GET /app/api/admin/people', { body: { people: [{ id: 'u-olga', name: 'Ольга' }] } });
    renderApp('/admin/modes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Новая задача' }));
    const dialog = screen.getByRole('dialog', { name: 'Новая задача' });
    await user.type(within(dialog).getByLabelText('Название'), 'Новая сделка');
    await user.click(within(dialog).getByRole('button', { name: 'По событию' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сообщение от другой системы' }));
    await user.selectOptions(within(dialog).getByLabelText('От чьего имени работает агент'), 'Ольга');
    await user.type(within(dialog).getByLabelText('Что сделать агенту'), 'Оцени сделку');
    await user.click(within(dialog).getByRole('button', { name: 'Создать задачу' }));
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/admin/tasks')?.body).toEqual({ title: 'Новая сделка', agentId: 'sales', trigger: 'webhook', executorId: 'u-olga', prompt: 'Оцени сделку' });
    expect(await screen.findByText('http://localhost:8080/app/api/hooks/s3cret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скопировать' })).toBeInTheDocument();
    expect(screen.getByText(/уйдёт по сети открытым текстом/)).toBeInTheDocument();
  });

  it('shows an event task by its events, and its latest events without the senders of letters', async () => {
    const MAIL = { ...TASK, id: 't3', title: 'Разбор входящих', trigger: 'mail', schedule: null, cron: null, mailFilter: { from: [], subject: ['заказ'] }, events: { fired: 14, skipped: 2 }, lastFire: null };
    const s = server([MAIL]);
    s.set('GET /app/api/admin/tasks/t3/events', { body: { events: [{ id: '1', receivedAt: '2026-11-22T06:00:00Z', summary: null, user: 'Ольга', outcome: 'done', reasonCode: null }], rejected: { tooLarge: 0, badFormat: 0 } } });
    renderApp('/admin/modes');
    const user = userEvent.setup();
    expect((await screen.findAllByText('По событию · письма')).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Сработала 14 раз за сутки · пропущено 2' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Последние события: Разбор входящих' });
    expect(within(dialog).getByText('Ольга')).toBeInTheDocument();
    expect(within(dialog).getByText('Выполнено')).toBeInTheDocument();
  });

  it('pauses a task with its switch and removes one after the question', async () => {
    const s = server();
    s.set('PUT /app/api/admin/tasks/t1/status', { body: { ...TASK, status: 'paused' } });
    s.set('DELETE /app/api/admin/tasks/t1', { body: { ok: true } });
    renderApp('/admin/modes');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Утренняя сводка' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ status: 'paused' }));
    await user.click(screen.getByRole('button', { name: 'Действия: Утренняя сводка' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить задачу «Утренняя сводка»?' });
    expect(within(question).getByText(/Вопросы, которые ждут решения сотрудников, будут отклонены/)).toBeInTheDocument();
    await user.click(within(question).getByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Задача удалена')).toBeInTheDocument();
  });

  it('keeps the cron of a stage-1 task when only its name changes', async () => {
    const legacy = { ...TASK, schedule: null, cron: '0 7 * * 1' };
    const s = server([legacy]);
    s.set('PUT /app/api/admin/tasks/t1', { body: legacy });
    renderApp('/admin/modes');
    const user = userEvent.setup();
    expect(await screen.findByText('по расписанию 0 7 * * 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Действия: Утренняя сводка' }));
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    const dialog = screen.getByRole('dialog', { name: 'Утренняя сводка' });
    expect(within(dialog).getByText(/Сейчас: по расписанию 0 7 \* \* 1/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Название'), ' руководителю');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toBeDefined());
    const body = s.calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(body.title).toBe('Утренняя сводка руководителю');
    expect(body).not.toHaveProperty('schedule');
  });

  it('says why a task stands still', async () => {
    server([{ ...TASK, status: 'paused', pausedReason: 'scope_empty', lastFire: null }]);
    renderApp('/admin/modes');
    expect(await screen.findByText('Некому выполнять')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'не запускалась' })).toBeInTheDocument();
  });
});
