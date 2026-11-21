// «Подключения» → «Сервер MCP» (docs/specs/[20.11.2026]-mcp-connections.md, step 8): from the address to «Включить»,
// a key in the address, and what the card of a server says.
import type { McpAction, McpServerView } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['connections'] };

const action = (name: string, serverTitle: string, tokens: number, over: Partial<McpAction> = {}): McpAction => ({
  name,
  modelName: `m1a2b3c_${name.replace(/\./g, '_')}`,
  title: null,
  serverTitle,
  description: '',
  enabled: false,
  readOnly: false,
  readOnlyHint: false,
  check: false,
  isNew: false,
  isChanged: false,
  tokens,
  ...over,
});

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: '0b8f5d6e-1c2a-4f3b-9d4e-5a6b7c8d9e0f',
  slug: 'm1a2b3c',
  title: 'Тестовая CRM',
  transport: 'http',
  url: 'https://crm.example.com/mcp',
  program: null,
  auth: 'none',
  fields: [],
  headers: {},
  env: {},
  clientId: null,
  clientSecretSet: false,
  sharedConfigured: false,
  status: 'draft',
  statusErrorCode: null,
  actions: [],
  snapshotAt: null,
  agents: ['sales'],
  usage: { using: 0, connected: 0, authErrors: 0, possible: 0 },
  createdAt: '2026-11-21T10:00:00.000Z',
  updatedAt: '2026-11-21T10:00:00.000Z',
  ...over,
});

const ACTIONS = [action('crm.deal.list', 'Найти сделки', 420, { readOnlyHint: true }), action('crm.deal.add', 'Создать сделку', 610)];
const AGENTS = { agents: [{ id: 'sales', name: 'Продажи', description: '', modelId: null, departmentNames: [], starters: [], startersCustom: false }], missingAgents: [] };

describe('a new server', () => {
  it('goes from the address to «Включить»: the server tells the way of sign-in, the admin turns on actions and agents', async () => {
    const checked = server({ actions: ACTIONS, snapshotAt: '2026-11-21T10:01:00.000Z' });
    const s = mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/connections': { body: { connections: [] } },
      'GET /app/api/admin/agents': { body: AGENTS },
      'POST /app/api/admin/mcp-servers/probe': { body: { auth: 'none' } },
      'POST /app/api/admin/mcp-servers': { body: { server: server() } },
      [`POST /app/api/admin/mcp-servers/${checked.id}/check`]: { body: { server: checked } },
      [`PATCH /app/api/admin/mcp-servers/${checked.id}`]: { body: { server: { ...checked, status: 'enabled' } } },
    });
    renderApp('/admin/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить сервер MCP' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сервер MCP' });
    await user.type(within(dialog).getByLabelText('Название'), 'Тестовая CRM');
    await user.type(within(dialog).getByLabelText('Адрес сервера'), 'https://crm.example.com/mcp');
    await user.click(within(dialog).getByRole('button', { name: 'Далее' }));
    expect(await within(dialog).findByText('Сервер пускает без входа.')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Без входа' })).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Сохранить черновик' }));
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/admin/mcp-servers')?.body).toMatchObject({ title: 'Тестовая CRM', url: 'https://crm.example.com/mcp', auth: 'none', fields: [], headers: {} });
    await user.click(await screen.findByRole('button', { name: 'Проверить своим доступом' }));

    expect(await screen.findByText('Найти сделки')).toBeInTheDocument();
    expect(screen.getByText('Сервер называет его чтением')).toBeInTheDocument();
    expect(screen.getByText('Включённые действия добавляют к каждому запросу агента около 0 токенов.')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Включить «Найти сделки»' }));
    expect(screen.getByText('Включённые действия добавляют к каждому запросу агента около 420 токенов.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('checkbox', { name: 'Только чтение — без «Да»' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Включить' }));

    await waitFor(() => expect(s.calls.find((c) => c.method === 'PATCH')).toBeDefined());
    expect(s.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      title: 'Тестовая CRM',
      actions: [
        { name: 'crm.deal.list', enabled: true, readOnly: true, title: null, check: false },
        { name: 'crm.deal.add', enabled: false, readOnly: false, title: null, check: false },
      ],
      agents: ['sales'],
      status: 'enabled',
    });
  });

  it('with a key in the address asks for its fields first: the address answers only with a value', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/connections': { body: { connections: [] } } });
    renderApp('/admin/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить сервер MCP' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сервер MCP' });
    await user.type(within(dialog).getByLabelText('Название'), 'МойСклад');
    // userEvent reads «{{» as a literal «{» — the address is pasted as people do it.
    await user.click(within(dialog).getByLabelText('Адрес сервера'));
    await user.paste('https://mcp.moysklad.example/{{token}}/mcp');
    await user.click(within(dialog).getByRole('button', { name: 'Далее' }));
    expect(await within(dialog).findByRole('radio', { name: 'Личный ключ сотрудника — каждый введёт свой' })).toBeChecked();
    expect(within(dialog).getByDisplayValue('token')).toBeInTheDocument();
    expect(s.calls.some((c) => c.path.endsWith('/probe'))).toBe(false);
  });
});

describe('the card of a server', () => {
  it('tells the state, the employees with broken access and the new actions', async () => {
    const working = server({
      title: 'Битрикс24',
      auth: 'oauth',
      status: 'enabled',
      snapshotAt: '2026-11-21T10:01:00.000Z',
      actions: [...ACTIONS, action('crm.task.add', 'Добавить задачу', 300, { isNew: true }), action('crm.task.list', 'Задачи', 300, { isNew: true })],
      usage: { using: 0, connected: 3, authErrors: 1, possible: 5 },
    });
    mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/connections': { body: { connections: [] } }, 'GET /app/api/admin/mcp-servers': { body: { servers: [server({ id: 'a1b2c3d4-0000-4000-8000-000000000001', title: 'Склад' }), working] } } });
    renderApp('/admin/connections');
    expect(await screen.findByText('Склад')).toBeInTheDocument();
    expect(screen.getByText('Черновик')).toBeInTheDocument();
    expect(screen.getByText('Ошибка доступа: 1')).toBeInTheDocument();
    expect(screen.getByText('Новых действий: 2')).toBeInTheDocument();
    expect(screen.getByText('3 из 5')).toBeInTheDocument();
  });
});

describe('a program server', () => {
  it('is a command and a pinned package with arguments, without an address and with the shared key in its environment', async () => {
    const s = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/connections': { body: { connections: [] } }, 'POST /app/api/admin/mcp-servers': { body: { server: server({ transport: 'program', url: null }) } } });
    renderApp('/admin/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить сервер MCP' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сервер MCP' });
    await user.type(within(dialog).getByLabelText('Название'), '1С');
    await user.click(within(dialog).getByRole('radio', { name: 'Программа (npx или uvx)' }));
    expect(within(dialog).queryByLabelText('Адрес сервера')).not.toBeInTheDocument();
    // A program is one process for everybody: no sign-in of each employee.
    expect(within(dialog).queryByRole('radio', { name: /Личный ключ/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /Вход через сайт/ })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Пакет с точной версией'), '1c-mcp-server@2.3.1');
    await user.type(within(dialog).getByLabelText('Аргументы — по одному в строке'), '--base{Enter}http://1c.local');
    await user.click(within(dialog).getByRole('radio', { name: 'Общий ключ организации — один на всех' }));
    await user.type(within(dialog).getByLabelText('Ключ API — значение организации'), 'shared-7731');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить черновик' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/admin/mcp-servers')).toBeDefined());
    expect(s.calls.find((c) => c.method === 'POST' && c.path === '/app/api/admin/mcp-servers')?.body).toEqual({
      title: '1С',
      transport: 'program',
      url: null,
      program: { runner: 'npx', package: '1c-mcp-server@2.3.1', args: ['--base', 'http://1c.local'] },
      auth: 'shared_key',
      fields: [{ key: 'token', label: 'Ключ API', hint: '', secret: true }],
      headers: {},
      env: { API_TOKEN: '{{token}}' },
      sharedValues: { token: 'shared-7731' },
      client: null,
    });
  });
});
