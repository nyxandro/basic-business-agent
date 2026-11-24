import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { PHONE_WIDTH, stubSystemTheme } from '../test/match-media.ts';
import { renderApp } from '../test/render.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: '', mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];
const QUESTION = {
  id: 'a1',
  agent: 'Продажи',
  task: 'Утренняя сводка',
  tool: 'mail_send',
  action: { title: 'Отправить письмо', fields: { to: 'Кому', text: 'Текст' }, readOnly: false },
  args: { to: 'client@example.com', text: 'Сводка готова' },
  createdAt: '2026-11-14T06:00:00.000Z',
  expiresAt: new Date(Date.now() + 3 * 3600_000 + 120_000).toISOString(),
  conversation: null,
};

function server(approvals: object, pending = 1) {
  const s = mockServer({
    'GET /app/api/me': { body: ME },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/projects': { body: { projects: [] } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: 3000, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/me/notifications': { body: { pendingApprovals: pending, unread: 0, latest: null } },
    'GET /app/api/approvals': { body: approvals },
    // The chat under the phone's sheet.
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
    'GET /app/api/threads/t1/project': { body: { projectId: null } },
  });
  s.set('POST /app/api/approvals/a1/decision', () => {
    s.set('GET /app/api/me/notifications', { body: { pendingApprovals: 0, unread: 0, latest: null } });
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

  // The stamp and the signature (docs/specs/[20.11.2026]-org-letterhead.md): a kind of document reads in words, an act with
  // the line about the consent of the other party.
  it('shows a value of a fixed set in words of the action', async () => {
    const sign = {
      ...QUESTION,
      tool: 'org_sign_document',
      action: { title: 'Поставить печать организации и подпись руководителя в документ Word', fields: { path: 'Документ', kind: 'Вид документа' }, readOnly: false, choices: { kind: { act: 'акт — первичный документ: факсимиле допустимо, только если это прямо предусмотрено договором с клиентом' } } },
      args: { path: 'Акт.docx', kind: 'act' },
    };
    server({ pending: [sign], failed: [] });
    renderApp('/approvals');
    const card = (await screen.findByText('Утренняя сводка')).closest('article')!;
    expect(within(card).getByText(/^акт — первичный документ/)).toBeInTheDocument();
    expect(within(card).queryByText('act')).not.toBeInTheDocument();
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

  // The bell's sheet on a phone opens on «Ждут решения» while a question waits (docs/specs/[20.11.2026]-notifications.md, F3).
  it('opens as a sheet from the bell on a phone', async () => {
    stubSystemTheme('light', PHONE_WIDTH);
    server({ pending: [QUESTION], failed: [] });
    renderApp('/agents/sales?thread=t1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: 1 вопрос ждёт решения' }));
    const sheet = await screen.findByRole('dialog', { name: 'Уведомления' });
    expect(within(sheet).getByRole('radio', { name: 'Ждут решения · 1' })).toHaveAttribute('aria-checked', 'true');
    await user.click(await within(sheet).findByRole('button', { name: 'Да, выполнить' }));
    expect(await within(sheet).findByText('Выполнено')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument();
  });

  // A question of a conversation is answered there (F4): the card leads to it.
  it('shows a question of a conversation with «Открыть разговор»', async () => {
    server({ pending: [{ ...QUESTION, id: 'a2', task: null, conversation: { threadId: 't9', agentId: 'sales', title: 'Счёт для Вектора' } }], failed: [] });
    renderApp('/approvals');
    const card = (await screen.findByText('Из разговора «Счёт для Вектора»')).closest('article')!;
    expect(within(card).getByRole('link', { name: 'Открыть разговор' })).toHaveAttribute('href', '/agents/sales?thread=t9');
    expect(within(card).queryByRole('button', { name: 'Да, выполнить' })).not.toBeInTheDocument();
  });

  // An old notification leads to its question: it is marked; a decided one says what became of it.
  it('marks the question of a notification, and tells a decided one instead of an empty screen', async () => {
    const s = server({ pending: [QUESTION], failed: [] });
    s.set('GET /app/api/approvals/gone', { body: { id: 'gone', status: 'approved', action: 'Отправить письмо клиенту', decidedAt: '2026-11-14T06:14:00.000Z' } });
    const first = renderApp('/approvals?question=a1');
    const card = (await screen.findByText('Утренняя сводка')).closest('article')!;
    expect(card.className).toMatch(/highlighted/);
    first.unmount();
    renderApp('/approvals?question=gone');
    expect(await screen.findByText(/^Вопрос уже решён: выполнено/)).toBeInTheDocument();
    expect(screen.getByText('Отправить письмо клиенту')).toBeInTheDocument();
  });

  // docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 3: a request waiting for my decision — its card, «Согласовать».
  it('shows a request waiting for my approval with «Зачем», and agrees to it', async () => {
    const s = server({ pending: [], failed: [] }, 1);
    const chain = {
      id: '12',
      status: 'pending',
      stage: 1,
      stages: ['руководитель отдела «Продажи»', 'Сергей Иванов'],
      action: { title: 'Изменить сделку', fields: { discount: 'Скидка' }, readOnly: false, tool: 'b24_deal_update' },
      args: { discount: 15 },
      comment: 'Клиент берёт три вагона',
      requester: 'Ольга Смирнова',
      agent: 'Продажи',
      createdAt: '2026-11-22T06:00:00Z',
      stageExpiresAt: '2026-11-25T06:00:00Z',
      decisions: [],
      errorCode: null,
      canDecide: true,
      canWithdraw: false,
      canRetry: false,
    };
    s.set('GET /app/api/approval-chains', { body: { forMe: [chain], mine: [] } });
    s.set('POST /app/api/approval-chains/12/decision', () => {
      s.set('GET /app/api/approval-chains', { body: { forMe: [], mine: [] } });
      return { body: { ...chain, stage: 2, canDecide: false } };
    });
    renderApp('/approvals');
    const card = await screen.findByRole('article', { name: 'Согласование №12 · этап 1 из 2' });
    expect(within(card).getByText('Изменить сделку')).toBeInTheDocument();
    expect(within(card).getByText(/Клиент берёт три вагона/)).toBeInTheDocument();
    expect(within(card).getByText(/^Просит: Ольга Смирнова, агент «Продажи»/)).toBeInTheDocument();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Согласовать' }));
    expect(s.calls.find((c) => c.path === '/app/api/approval-chains/12/decision')?.body).toEqual({ approve: true });
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Согласование №12 · этап 1 из 2' })).not.toBeInTheDocument());
  });
});
