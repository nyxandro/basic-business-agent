// The chat opened while the server did not answer (review 24.11): the person sees that there is no connection and that the
// chat tries again, cannot send into nowhere, and the chat comes back by itself when the server does.
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ME, mockServer, type Reply } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { connectionTexts } from '../i18n/connection.ts';
import { RETRY_FIRST_MS } from './runtime-recovery.ts';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки', starters: [], mark: { kind: 'icon', icon: 'spark' }, actions: {}, systems: { tools: {}, prefixes: {} } }];
const INFO: Reply = { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } };

describe('the chat without a connection to the server', () => {
  it('says so, does not send, tries again by itself and comes back', async () => {
    let serverUp = false;
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/agents': { body: { agents: AGENTS } },
      'GET /app/api/threads': { body: { threads: [], next: null } },
      'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
      'GET /app/api/copilotkit/info': () => (serverUp ? INFO : { status: 502, raw: 'Bad Gateway' }),
    });
    renderApp('/agents/sales');
    expect(await screen.findByText(connectionTexts.lost, {}, { timeout: 5_000 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();

    serverUp = true;
    await waitFor(() => expect(screen.queryByText(connectionTexts.lost)).toBeNull(), { timeout: RETRY_FIRST_MS * 4 });
  }, 20_000);
});
