// MCP servers in «Настройки → Подключения» (docs/specs/[20.11.2026]-mcp-connections.md, scenario 2; F2): the person
// turns on a server without a sign-in, enters their own key, signs in on the system's site.
import type { MyMcpServer } from '@bba/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const mine = (over: Partial<MyMcpServer>): MyMcpServer => ({
  id: '0b8f5d6e-1c2a-4f3b-9d4e-5a6b7c8d9e0f',
  title: 'Склад',
  auth: 'none',
  fields: [],
  using: false,
  status: 'not_connected',
  checkedAt: null,
  agents: ['Продажи'],
  trouble: null,
  ...over,
});

describe('a server the admin allowed for my agents', () => {
  it('without a sign-in is turned on with «Использовать»', async () => {
    const shared = mine({});
    const s = mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/me/connections': { body: { connections: [] } }, 'GET /app/api/me/connections/mcp': { body: { servers: [shared] } }, [`POST /app/api/me/connections/mcp/${shared.id}/use`]: { body: { ok: true } } });
    renderApp('/settings/connections');
    expect(await screen.findByText('Нужно агенту «Продажи»')).toBeInTheDocument();
    expect(screen.getByText('Выключено')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Использовать «Склад»' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ on: true }));
  });

  it('with a personal key takes the fields the admin described', async () => {
    const keyed = mine({ title: 'МойСклад', auth: 'personal_key', fields: [{ key: 'token', label: 'Ключ API', hint: 'Настройки → Интеграции', secret: true }] });
    const s = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/connections': { body: { connections: [] } },
      'GET /app/api/me/connections/mcp': { body: { servers: [keyed] } },
      [`PUT /app/api/me/connections/mcp/${keyed.id}`]: { body: { status: 'unverified' } },
    });
    renderApp('/settings/connections');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Ключ API'), 'ms-key-1');
    expect(screen.getByText('Настройки → Интеграции')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ fields: { token: 'ms-key-1' } }));
  });

  it('with a sign-in sends me to the system’s site and greets me back', async () => {
    const oauth = mine({ title: 'Битрикс24', auth: 'oauth' });
    mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/me/connections': { body: { connections: [] } },
      'GET /app/api/me/connections/mcp': { body: { servers: [oauth] } },
      [`POST /app/api/me/connections/mcp/${oauth.id}/sign-in`]: { body: { url: 'https://portal.example.com/oauth/authorize?state=s' } },
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderApp(`/settings/connections?connected=mcp:${oauth.id}`);
    expect(await screen.findByText('«Битрикс24» подключена.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://portal.example.com/oauth/authorize?state=s'));
  });
});
