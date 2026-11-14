import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer, type Reply } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['models'] };
const PRICES = { input: 120, output: 360, cacheRead: 30, cacheWrite: 120, reasoning: 360, image: 2 };
const GIGA = { id: 'gigachat', kind: 'chat', label: 'GigaChat 2 Max', connection: 'api_key', providerModel: 'gigachat/GigaChat-2-Max', apiBase: null, vision: true, enabled: true, prices: PRICES, pricePerMinute: null, keys: [{ id: 'k-00000001', last4: 'a1b2', createdAt: '2026-11-10T08:00:00Z' }], agentIds: [] };
const TEXT_ONLY = { ...GIGA, id: 'yagpt', label: 'YandexGPT 5 Pro', providerModel: 'yandex/yandexgpt-5-pro', vision: false, keys: [{ id: 'k-00000002', last4: 'c3d4', createdAt: '2026-11-10T08:00:00Z' }] };
const SETTINGS = { primaryModelId: 'gigachat', fallbackModelId: null, transcriptionModelId: null, agentsChooseModel: false };

function server(models: object[] = [GIGA, TEXT_ONLY]) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/models': { body: { models, settings: SETTINGS, gateway: { reachable: true, checkedAt: '2026-11-14T08:00:00Z', pendingModelIds: [] } } },
  });
}

async function fillNewModel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Добавить модель' }));
  const dialog = screen.getByRole('dialog', { name: 'Добавить модель' });
  await user.type(within(dialog).getByLabelText('Название'), 'GPT-4.1 mini');
  await user.type(within(dialog).getByLabelText('Провайдер и модель'), 'openai/gpt-4.1-mini');
  await user.type(within(dialog).getByLabelText('Ключ'), 'sk-test-0000000000');
  for (const [label, value] of [['Вход', '40'], ['Выход', '160'], ['Кэш чтения', '10'], ['Кэш записи', '40'], ['Рассуждения', '160'], ['Картинка, ₽', '1']] as const) {
    await user.type(within(dialog).getByLabelText(label), value);
  }
  return dialog;
}

describe('«Нейросеть»', () => {
  it('shows the gateway, the organisation’s choice and the catalog with roles and prices', async () => {
    server();
    renderApp('/admin/models');
    expect(await screen.findByText(/Шлюз работает/)).toBeInTheDocument();
    const row = screen.getByRole('switch', { name: 'GigaChat 2 Max' }).closest('tr')!;
    expect(within(row).getByText('Основная')).toBeInTheDocument();
    expect(within(row).getByText('ключ организации · …a1b2')).toBeInTheDocument();
    expect(within(row).getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Без запасной', { selector: 'div' })).toBeInTheDocument();
  });

  it('checks the key before adding a model: «Проверяю ключ…» → «Ключ подошёл»', async () => {
    const s = server();
    let answer: (r: Reply) => void = () => undefined;
    s.set('POST /app/api/admin/models', () => new Promise<Reply>((resolve) => (answer = resolve)));
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await fillNewModel(user);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(within(dialog).getByRole('button', { name: 'Проверяю ключ…' })).toBeDisabled();
    answer({ status: 201, body: { ...GIGA, id: 'gpt-mini' } });
    expect(await screen.findByText('Ключ подошёл')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'chat',
      label: 'GPT-4.1 mini',
      connection: 'api_key',
      providerModel: 'openai/gpt-4.1-mini',
      apiBase: null,
      vision: true,
      prices: { input: 40, output: 160, cacheRead: 10, cacheWrite: 40, reasoning: 160, image: 1 },
      pricePerMinute: null,
      key: 'sk-test-0000000000',
    });
  });

  it('keeps the form and says why when the provider refuses the key', async () => {
    const s = server();
    s.set('POST /app/api/admin/models', apiError('APP_MODEL_CHECK_FAILED', 'Провайдер не принял ключ. Проверьте ключ и модель провайдера.', 400));
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await fillNewModel(user);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText('Провайдер не принял ключ. Проверьте ключ и модель провайдера.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Название')).toHaveValue('GPT-4.1 mini');
  });

  it('refuses a main model that does not see images and puts the choice back', async () => {
    const s = server();
    s.set('PUT /app/api/admin/models/settings', apiError('APP_VALIDATION_FAILED', 'Основной и запасной нужна модель, которая видит картинки: иначе агенты не прочитают сканы.', 400));
    renderApp('/admin/models');
    const user = userEvent.setup();
    const primary = await screen.findByRole('combobox', { name: 'Основная модель' });
    await user.selectOptions(primary, 'YandexGPT 5 Pro');
    expect(await screen.findByText(/нужна модель, которая видит картинки/)).toBeInTheDocument();
    expect(primary).toHaveValue('gigachat');
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ ...SETTINGS, primaryModelId: 'yagpt' });
  });

  it('adds a key of a model and says why the last one cannot go', async () => {
    const s = server();
    s.set('POST /app/api/admin/models/gigachat/keys', { status: 201, body: { id: 'k-00000003', last4: 'e5f6', createdAt: '2026-11-14T08:00:00Z' } });
    s.set('DELETE /app/api/admin/models/gigachat/keys/k-00000001', apiError('APP_VALIDATION_FAILED', 'Это последний ключ модели — без него она перестанет отвечать. Добавьте новый ключ или удалите модель.', 400));
    renderApp('/admin/models');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия: GigaChat 2 Max' }));
    await user.click(screen.getByRole('menuitem', { name: 'Ключи' }));
    const dialog = screen.getByRole('dialog', { name: 'Ключи: GigaChat 2 Max' });
    expect(within(dialog).getByText(/Ключ сохранён · …a1b2/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Новый ключ'), 'sk-new-0000000000');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить ключ' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/keys') && c.method === 'POST')?.body).toEqual({ key: 'sk-new-0000000000' }));
    await user.click(within(dialog).getByRole('button', { name: 'Удалить ключ …a1b2' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }));
    expect(await within(dialog).findByText(/Это последний ключ модели/)).toBeInTheDocument();
  });

  it('switches a model off', async () => {
    const s = server();
    s.set('PUT /app/api/admin/models/yagpt', { body: { ...TEXT_ONLY, enabled: false } });
    renderApp('/admin/models');
    await userEvent.setup().click(await screen.findByRole('switch', { name: 'YandexGPT 5 Pro' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/models/yagpt')?.body).toEqual({ enabled: false }));
  });
});
