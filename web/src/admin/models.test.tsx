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

function server(models: object[] = [GIGA, TEXT_ONLY], me: object = ADMIN) {
  return mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/admin/models': { body: { models, settings: SETTINGS, accounts: [], gateway: { reachable: true, checkedAt: '2026-11-14T08:00:00Z', pendingModelIds: [] } } },
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
  it('shows the gateway between the lead and the catalog, and the catalog with roles and prices — without the tiles of the choice', async () => {
    server();
    renderApp('/admin/models');
    const gateway = await screen.findByText(/Шлюз работает/);
    const lead = screen.getByText(/Модели, их ключи и цены/);
    const catalog = screen.getByRole('heading', { name: 'Каталог моделей' });
    expect(lead.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gateway.compareDocumentPosition(catalog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = screen.getByRole('switch', { name: 'GigaChat 2 Max' }).closest('tr')!;
    expect(within(row).getByText('Основная')).toBeInTheDocument();
    expect(within(row).getByText('ключ организации · …a1b2')).toBeInTheDocument();
    expect(within(row).getByText('120')).toBeInTheDocument();
    // The four tiles are gone (owner's list 16.11).
    for (const tile of ['При сбое переключаться на', 'Распознавание речи', 'Без запасной']) expect(screen.queryByText(tile, { selector: 'div' })).not.toBeInTheDocument();
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
      maxOutputTokens: null,
    });
    // The gateway knows the model: the form does not ask for the length of an answer.
    expect(screen.queryByLabelText('Наибольшая длина ответа, токенов')).not.toBeInTheDocument();
  });

  it('asks for the length of an answer only when the gateway does not know the model, and sends it', async () => {
    const s = server();
    const posted: unknown[] = [];
    s.set('POST /app/api/admin/models', (call) => {
      posted.push(call.body);
      return posted.length === 1
        ? apiError('APP_MODEL_OUTPUT_LIMIT_REQUIRED', 'Шлюз не знает, какой длины ответ даёт эта модель. Укажите наибольшую длину ответа в токенах — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).', 400)
        : { status: 201, body: { ...GIGA, id: 'qwen', maxOutputTokens: 16384 } };
    });
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await fillNewModel(user);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText(/Шлюз не знает, какой длины ответ даёт эта модель/)).toBeInTheDocument();
    const limit = within(dialog).getByLabelText('Наибольшая длина ответа, токенов');

    await user.type(limit, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText('Длина ответа — целое число токенов больше нуля.')).toBeInTheDocument();
    expect(posted).toHaveLength(1);

    await user.clear(limit);
    await user.type(limit, '16 384');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await screen.findByText('Ключ подошёл')).toBeInTheDocument();
    expect(posted[1]).toMatchObject({ providerModel: 'openai/gpt-4.1-mini', maxOutputTokens: 16384 });
  });

  it('asks for a smaller length of an answer when the provider refuses the model’s one, and sends it', async () => {
    const s = server();
    const posted: unknown[] = [];
    s.set('POST /app/api/admin/models', (call) => {
      posted.push(call.body);
      return posted.length === 1
        ? apiError('APP_MODEL_OUTPUT_LIMIT_REJECTED', 'Провайдер не принял наибольшую длину ответа: 131 072. Укажите меньшую — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).', 400)
        : { status: 201, body: { ...GIGA, id: 'qwen', maxOutputTokens: 16384 } };
    });
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await fillNewModel(user);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText(/Провайдер не принял наибольшую длину ответа: 131 072/)).toBeInTheDocument();
    // The gateway knows this model: the hint says why the number is asked for.
    expect(within(dialog).getByText('Провайдер не принял прежнее число — укажите меньшее, оно есть в описании модели у провайдера.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Шлюз не знает эту модель — число есть в её описании у провайдера.')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Наибольшая длина ответа, токенов'), '16 384');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await screen.findByText('Ключ подошёл')).toBeInTheDocument();
    expect(posted[1]).toMatchObject({ providerModel: 'openai/gpt-4.1-mini', maxOutputTokens: 16384 });
  });

  // The limit was asked for that model: another one may be known to the gateway.
  it('stops asking for the length of an answer when the admin changes the model', async () => {
    const s = server();
    const posted: unknown[] = [];
    s.set('POST /app/api/admin/models', (call) => {
      posted.push(call.body);
      return posted.length === 1
        ? apiError('APP_MODEL_OUTPUT_LIMIT_REQUIRED', 'Шлюз не знает, какой длины ответ даёт эта модель. Укажите наибольшую длину ответа в токенах — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).', 400)
        : { status: 201, body: { ...GIGA, id: 'gpt-mini' } };
    });
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await fillNewModel(user);
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    await user.type(await within(dialog).findByLabelText('Наибольшая длина ответа, токенов'), '16384');

    const model = within(dialog).getByLabelText('Провайдер и модель');
    await user.clear(model);
    await user.type(model, 'openai/gpt-4.1');
    expect(within(dialog).queryByLabelText('Наибольшая длина ответа, токенов')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Шлюз не знает, какой длины ответ даёт эта модель/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await screen.findByText('Ключ подошёл')).toBeInTheDocument();
    expect(posted[1]).toMatchObject({ providerModel: 'openai/gpt-4.1', maxOutputTokens: null });
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

describe('editing a model (owner\'s list 16.11)', () => {
  const MOVED = { ...GIGA, apiBase: 'https://gigachat.example.com/v1' };
  // A new address receives the model's keys: only the superadmin moves a model.
  const SUPERADMIN = { ...ADMIN, isSuperadmin: true };

  async function edit(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(await screen.findByRole('button', { name: `Действия: ${label}` }));
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    return screen.getByRole('dialog', { name: label });
  }

  it('shows the provider address in the catalog and in «Изменить», and sends a new one to be checked with the keys', async () => {
    const s = server([MOVED], SUPERADMIN);
    let answer: (r: Reply) => void = () => undefined;
    s.set('PUT /app/api/admin/models/gigachat', () => new Promise<Reply>((resolve) => (answer = resolve)));
    renderApp('/admin/models');
    const user = userEvent.setup();
    const row = (await screen.findByRole('switch', { name: 'GigaChat 2 Max' })).closest('tr')!;
    expect(within(row).getByText('https://gigachat.example.com/v1')).toBeInTheDocument();

    const dialog = await edit(user, 'GigaChat 2 Max');
    const address = within(dialog).getByLabelText('Адрес провайдера (если не стандартный)');
    expect(address).toHaveValue('https://gigachat.example.com/v1');
    // The keys are changed in «Ключи», not here.
    expect(within(dialog).queryByLabelText('Ключ')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeEnabled();
    await user.clear(address);
    await user.type(address, 'https://gc.example.org/api/v1');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(within(dialog).getByRole('button', { name: 'Проверяю ключ…' })).toBeDisabled();
    expect(s.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ label: 'GigaChat 2 Max', apiBase: 'https://gc.example.org/api/v1' });
    answer({ body: { ...GIGA, apiBase: 'https://gc.example.org/api/v1' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'GigaChat 2 Max' })).not.toBeInTheDocument());
  });

  it('an emptied address means the standard one; an unchanged address is not sent', async () => {
    const s = server([MOVED], SUPERADMIN);
    s.set('PUT /app/api/admin/models/gigachat', { body: GIGA });
    renderApp('/admin/models');
    const user = userEvent.setup();
    let dialog = await edit(user, 'GigaChat 2 Max');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(s.calls.filter((c) => c.method === 'PUT').at(-1)?.body).not.toHaveProperty('apiBase');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = await edit(user, 'GigaChat 2 Max');
    await user.clear(within(dialog).getByLabelText('Адрес провайдера (если не стандартный)'));
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(s.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toMatchObject({ apiBase: null });
  });

  it('keeps the form and says why when the keys do not work at the new address', async () => {
    const s = server([MOVED], SUPERADMIN);
    s.set('PUT /app/api/admin/models/gigachat', apiError('APP_MODEL_CHECK_FAILED', 'Провайдер не ответил. Попробуйте ещё раз.', 400));
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await edit(user, 'GigaChat 2 Max');
    const address = within(dialog).getByLabelText('Адрес провайдера (если не стандартный)');
    await user.clear(address);
    await user.type(address, 'https://wrong.example.org/v1');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText(/Провайдер не ответил/)).toBeInTheDocument();
    expect(address).toHaveValue('https://wrong.example.org/v1');
  });

  it('shows the address to another admin of «Нейросеть» but leaves its change to the superadmin', async () => {
    const s = server([MOVED]);
    s.set('PUT /app/api/admin/models/gigachat', { body: MOVED });
    renderApp('/admin/models');
    const user = userEvent.setup();
    const dialog = await edit(user, 'GigaChat 2 Max');
    const address = within(dialog).getByLabelText('Адрес провайдера (если не стандартный)');
    expect(address).toHaveValue('https://gigachat.example.com/v1');
    expect(address).toBeDisabled();
    expect(within(dialog).getByText('Адрес меняет только суперадминистратор: на новый адрес уходят ключи модели.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(s.calls.find((c) => c.method === 'PUT')?.body).not.toHaveProperty('apiBase');
  });

  it('a subscription model has no provider address', async () => {
    server([{ ...GIGA, id: 'm-sub', label: 'GPT по подписке', connection: 'chatgpt', providerModel: 'chatgpt/gpt-5.4', prices: null, keys: [] }]);
    renderApp('/admin/models');
    const dialog = await edit(userEvent.setup(), 'GPT по подписке');
    expect(within(dialog).queryByLabelText('Адрес провайдера (если не стандартный)')).not.toBeInTheDocument();
  });
});
