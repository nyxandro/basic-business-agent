import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const QUESTION = {
  id: 'a1',
  agent: 'Продажи',
  task: 'Утренняя сводка',
  tool: 'mail_send',
  args: { to: 'client@example.com', text: 'Сводка готова' },
  createdAt: '2026-11-14T06:00:00.000Z',
  expiresAt: new Date(Date.now() + 3 * 3600_000 + 120_000).toISOString(),
};

describe('approvals screen', () => {
  it('shows the question with its deadline, and the decision removes it', async () => {
    const server = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/notifications': { body: { pendingApprovals: 1, unreadResults: 0 } },
      'GET /app/api/approvals': { body: { pending: [QUESTION], failed: [] } },
    });
    server.set('POST /app/api/approvals/a1/decision', () => {
      server.set('GET /app/api/approvals', { body: { pending: [], failed: [] } });
      server.set('GET /app/api/me/notifications', { body: { pendingApprovals: 0, unreadResults: 0 } });
      return { body: { ok: true } };
    });
    renderApp('/approvals');
    expect(await screen.findByText('Продажи · Задача «Утренняя сводка»')).toBeInTheDocument();
    expect(screen.getByText('client@example.com')).toBeInTheDocument();
    expect(screen.getByText(/истекает через 3 ч/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ждёт подтверждения\s*1/ })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Да, выполнить' }));
    expect(await screen.findByText('Решений от вас не ждут')).toBeInTheDocument();
    expect(server.calls.find((c) => c.path === '/app/api/approvals/a1/decision')?.body).toEqual({ approved: true });
    expect(await screen.findByRole('link', { name: 'Ждёт подтверждения' })).toBeInTheDocument();
  });

  it('lists what did not work out in plain words', async () => {
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/approvals': {
        body: {
          pending: [],
          failed: [
            { at: '2026-11-13T06:00:00.000Z', agent: 'Продажи', task: 'Сводка', event: 'approval_expired', tool: 'mail_send', code: 'APP_APPROVAL_EXPIRED' },
            { at: '2026-11-12T06:00:00.000Z', agent: 'Продажи', task: 'Сводка', event: 'background_finished', tool: null, code: 'APP_MODEL_UNAVAILABLE' },
          ],
        },
      },
    });
    renderApp('/approvals');
    expect(await screen.findByText(/Истекло: действие не выполнено/)).toBeInTheDocument();
    expect(screen.getByText(/Задача «Сводка» не выполнилась/)).toBeInTheDocument();
    expect(screen.getByText(/APP_MODEL_UNAVAILABLE/)).toBeInTheDocument();
  });
});
