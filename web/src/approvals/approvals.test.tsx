import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: '', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } }];
const QUESTION = {
  id: 'a1',
  agent: 'Продажи',
  task: 'Утренняя сводка',
  tool: 'mail_send',
  action: { title: 'Отправить письмо', fields: { to: 'Кому', text: 'Текст' }, readOnly: false },
  args: { to: 'client@example.com', text: 'Сводка готова' },
  createdAt: '2026-11-14T06:00:00.000Z',
  expiresAt: new Date(Date.now() + 3 * 3600_000 + 120_000).toISOString(),
};

function server(approvals: object, pending = 1) {
  const s = mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/projects': { body: { projects: [] } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/me/notifications': { body: { pendingApprovals: pending, unreadResults: 0 } },
    'GET /app/api/approvals': { body: approvals },
    // The chat under the phone's sheet.
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/threads/t1/project': { body: { projectId: null } },
  });
  s.set('POST /app/api/approvals/a1/decision', () => {
    s.set('GET /app/api/me/notifications', { body: { pendingApprovals: 0, unreadResults: 0 } });
    return { body: { ok: true } };
  });
  return s;
}

describe('«Ждёт подтверждения»', () => {
  it('shows what the action will do with its deadline; «Да» shows «Выполнено» and updates the counter', async () => {
    const s = server({ pending: [QUESTION], failed: [] });
    renderApp('/approvals');
    const card = (await screen.findByText('Утренняя сводка')).closest('article')!;
    expect(within(card).getByText('· агент Продажи')).toBeInTheDocument();
    expect(within(card).getByText('Отправить письмо')).toBeInTheDocument();
    expect(within(card).getByText('Кому')).toBeInTheDocument();
    expect(within(card).getByText('client@example.com')).toBeInTheDocument();
    expect(within(card).getByText(/истекает через 3 ч/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ждёт подтверждения.*1/ })).toBeInTheDocument();

    await userEvent.setup().click(within(card).getByRole('button', { name: 'Да, выполнить' }));
    expect(await within(card).findByText('Выполнено')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Да, выполнить' })).not.toBeInTheDocument();
    expect(s.calls.find((c) => c.path === '/app/api/approvals/a1/decision')?.body).toEqual({ approved: true });
    // Nothing waits any more: the item leaves the side panel.
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Ждёт подтверждения/ })).not.toBeInTheDocument());
  });

  it('shows «Отклонено» after «Нет»', async () => {
    const s = server({ pending: [QUESTION], failed: [] });
    renderApp('/approvals');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Нет' }));
    expect(await screen.findByText('Отклонено')).toBeInTheDocument();
    expect(s.calls.find((c) => c.path === '/app/api/approvals/a1/decision')?.body).toEqual({ approved: false });
  });

  it('lists what did not work out, with «Подключить заново» when access to a system is lost', async () => {
    server(
      {
        pending: [],
        failed: [
          { at: '2026-11-13T15:40:00.000Z', agent: 'Продажи', task: 'Перенос заявок', event: 'background_finished', tool: 'crm_create_deal', code: 'APP_CONNECTOR_AUTH_FAILED' },
          { at: '2026-11-13T06:00:00.000Z', agent: 'Продажи', task: 'Сводка', event: 'approval_expired', tool: 'mail_send', code: 'APP_APPROVAL_EXPIRED' },
          { at: '2026-11-12T06:00:00.000Z', agent: 'Продажи', task: 'Сводка', event: 'background_finished', tool: null, code: 'APP_MODEL_UNAVAILABLE' },
        ],
      },
      0,
    );
    renderApp('/approvals');
    expect(await screen.findByText('Решений не ждёт ни одно действие.')).toBeInTheDocument();
    expect(screen.getByText('Действие не выполнено: доступ к системе истёк')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подключить заново' })).toHaveAttribute('href', '/settings/connections');
    expect(screen.getByText('Истекло: действие не выполнено')).toBeInTheDocument();
    expect(screen.getByText('Задача не выполнилась')).toBeInTheDocument();
    expect(screen.getByText(/APP_MODEL_UNAVAILABLE/)).toBeInTheDocument();
  });

  it('opens as a sheet from the bell on a phone', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    server({ pending: [QUESTION], failed: [] });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ждёт подтверждения: 1' }));
    const sheet = await screen.findByRole('dialog', { name: 'Ждёт подтверждения' });
    expect(within(sheet).getByText('Вопросы от фоновых задач агентов')).toBeInTheDocument();
    await user.click(await within(sheet).findByRole('button', { name: 'Да, выполнить' }));
    expect(await within(sheet).findByText('Выполнено')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog', { name: 'Ждёт подтверждения' })).not.toBeInTheDocument();
  });
});

