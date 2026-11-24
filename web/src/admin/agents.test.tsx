import type { PromptState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['agents'] };
const D1 = '00000000-0000-4000-8000-0000000000d1';
const DEPARTMENTS = [{ id: D1, name: 'Отдел продаж', userIds: [], agentIds: ['sales'], headIds: [] }];
const PEOPLE = [{ id: 'u2', name: 'Пётр Иванов' }];
const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки', modelId: null, access: { org: false, departmentIds: [D1], userIds: [] as string[] }, skillNames: ['kp-builder'], promptChanged: true, mark: { kind: 'icon', icon: 'headset', image: null }, abilities: { web: true, commands: true, widgets: true } };
const ASSISTANT = { ...AGENT, id: 'assistant', name: 'Общий помощник', description: 'Вопросы', access: { org: false, departmentIds: [], userIds: [] }, skillNames: [], promptChanged: false, mark: { kind: 'image', icon: 'spark', image: { url: '/app/api/agents/assistant/image?v=0123456789ab' } } };
const skill = (name: string, title: string, system = false) => ({ name, title, description: '', sizeBytes: 1, files: [], hasScripts: false, enabled: true, agentIds: [], system, uploadedAt: null, uploadedBy: null });
const SKILLS = [skill('docx', 'Документы Word', true), skill('contract-check', 'Проверка договора'), skill('kp-builder', 'Коммерческое предложение')];
const PROMPT = {
  agentId: 'sales',
  fileInstructions: 'Ты агент продаж.',
  publishedInstructions: null,
  draftInstructions: null,
  draftVersionId: null,
  draftBy: null,
  publishedAt: null,
  fileChangedSincePublish: false,
  modelId: null,
  allowedModels: [] as { id: string; label: string }[],
  primaryModel: 'qwen3.8-flash' as string | null,
};

function server(prompt: object = PROMPT, agents: object[] = [AGENT], missing: string[] = []) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/agents': { body: { agents, missingAgents: missing } },
    'GET /app/api/admin/tasks': { body: { tasks: [] } },
    'GET /app/api/admin/agents/sales/prompt': { body: prompt },
    'GET /app/api/admin/departments': { body: { departments: DEPARTMENTS } },
    'GET /app/api/admin/people': { body: { people: PEOPLE } },
    'GET /app/api/admin/skills': { body: { skills: SKILLS, sandbox: { programs: [], python: [], node: [] } } },
  });
}

const tabs = () => screen.getByRole('navigation', { name: 'Разделы агента' });

describe('«Агенты и промпты»: the list', () => {
  it('lists the agents with their marks, who may use them and an edited prompt; a click opens the agent’s page', async () => {
    server(PROMPT, [AGENT, ASSISTANT]);
    renderApp('/admin/agents');
    const list = await screen.findByRole('list', { name: 'Агенты' });
    const rows = within(list).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/admin/agents/sales', '/admin/agents/assistant']);
    expect(within(rows[0]!).getByText('Отделы: Отдел продаж')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Изменён в админке')).toBeInTheDocument();
    expect(rows[0]!.querySelector('[data-agent-mark="icon"]')).toHaveAttribute('data-icon', 'headset');
    expect(within(rows[1]!).getByText('Никому не доступен')).toBeInTheDocument();
    expect(rows[1]!.querySelector('[data-agent-mark="image"] img')).toHaveAttribute('src', ASSISTANT.mark.image.url);
    // No editor on the list: the prompt is on the agent's page.
    expect(screen.queryByRole('textbox', { name: 'Промпт агента' })).not.toBeInTheDocument();

    await userEvent.setup().click(rows[0]!);
    expect(await screen.findByRole('heading', { name: 'Продажи', level: 1 })).toBeInTheDocument();
    expect(within(tabs()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Инструкции', 'Настройки', 'Скиллы', 'Доступ', 'Значок']);
    expect(within(tabs()).getByRole('link', { name: 'Инструкции' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('textbox', { name: 'Промпт агента' })).toBeInTheDocument();
  });

  it('names agents departments point at but the installation lost', async () => {
    server(PROMPT, [AGENT], ['old-agent']);
    renderApp('/admin/agents');
    expect(await screen.findByText(/old-agent/)).toBeInTheDocument();
  });
});

describe('the page of an agent', () => {
  it('«Инструкции»: shows how the prompt is put together, the project layer included', async () => {
    server();
    renderApp('/admin/agents/sales');
    const layers = await screen.findByRole('list', { name: 'Слои промпта' });
    expect(within(layers).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Правила ядра', 'Промпт агента', 'Профиль организации', 'Профиль сотрудника', 'Проект: память, разговоры, файлы', 'Личная память']);
    expect(screen.getByText('Отделы: Отдел продаж')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Проверить в чате' })).toHaveAttribute('href', '/admin/agents/sales/check');
    // The model is in «Настройки».
    expect(screen.queryByRole('combobox', { name: 'Модель агента' })).not.toBeInTheDocument();
  });

  it('keeps the typed text when someone else changed the prompt meanwhile', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/prompt/draft', apiError('APP_AGENT_DRAFT_CONFLICT', 'Пока вы редактировали, промпт изменил(а) Ольга. Скопируйте свой текст, обновите страницу и внесите правку в свежую версию.', 409));
    renderApp('/admin/agents/sales');
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Промпт агента' });
    await user.type(field, ' Отвечай кратко.');
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    expect(await screen.findByText(/промпт изменил\(а\) Ольга/)).toBeInTheDocument();
    expect(field).toHaveValue('Ты агент продаж. Отвечай кратко.');
  });

  it('«Настройки»: the model and «Что агенту можно», no starter questions of the empty chat (owner 24.11)', async () => {
    server();
    renderApp('/admin/agents/sales/settings');
    expect(within(await screen.findByRole('navigation', { name: 'Разделы агента' })).getByRole('link', { name: 'Настройки' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('combobox', { name: 'Модель агента' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Доступ к сети интернет' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Подсказки в пустом чате' })).not.toBeInTheDocument();
    expect(screen.queryByText(/подсказки/i)).not.toBeInTheDocument();
  });

  it('«Настройки»: «Что агенту можно» saves a switch at once and keeps it as it was when the server fails', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/abilities', { body: { abilities: { web: false, commands: true, widgets: true } } });
    renderApp('/admin/agents/sales/settings');
    const user = userEvent.setup();
    const web = await screen.findByRole('switch', { name: 'Доступ к сети интернет' });
    const commands = screen.getByRole('switch', { name: 'Доступ к выполнению команд терминала' });
    expect(web).toHaveAttribute('aria-checked', 'true');
    expect(commands).toHaveAttribute('aria-checked', 'true');
    // «Виджеты в чате» (spec, section 8.31): the third switch, on by default.
    expect(screen.getByRole('switch', { name: 'Виджеты в чате' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Собирает в ответе экраны из готовых элементов/)).toBeInTheDocument();
    expect(screen.getByText(/помощник агента: он видит только задание/)).toBeInTheDocument();
    await user.click(web);
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/abilities'))?.body).toEqual({ web: false }));
    await waitFor(() => expect(web).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();

    s.set('PUT /app/api/admin/agents/sales/abilities', apiError('APP_INTERNAL', 'Что-то пошло не так.', 500));
    await user.click(commands);
    expect(await screen.findByText(/Что-то пошло не так/)).toBeInTheDocument();
    expect(commands).toHaveAttribute('aria-checked', 'true');
  });

  it('«Настройки»: keeps the agent’s model inactive while agents may not choose one, and saves a choice otherwise', async () => {
    server();
    const view = renderApp('/admin/agents/sales/settings');
    const off = await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(off).toBeDisabled();
    expect(screen.getByText(/включите «Агенты выбирают модель из каталога»/)).toBeInTheDocument();
    view.unmount();

    const s = server({ ...PROMPT, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] });
    s.set('PUT /app/api/admin/agents/sales/model', { body: { ok: true } });
    renderApp('/admin/agents/sales/settings');
    const on = await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(on).toBeEnabled();
    await userEvent.setup().selectOptions(on, 'GigaChat 2 Max');
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/model'))?.body).toEqual({ modelId: 'gigachat' }));
  });

  it('«Настройки»: names the organisation’s primary model in the first option, and says when none is on', async () => {
    server();
    const view = renderApp('/admin/agents/sales/settings');
    await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(screen.getByRole('option', { name: 'Основная организации (qwen3.8-flash)' })).toBeInTheDocument();
    view.unmount();

    server({ ...PROMPT, primaryModel: null });
    renderApp('/admin/agents/sales/settings');
    await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(screen.getByRole('option', { name: 'Основная организации (не выбрана)' })).toBeInTheDocument();
  });

  it('keeps the unsaved prompt through a look at other sections and a change of the model', async () => {
    let model: string | null = null;
    const s = server({ ...PROMPT, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] });
    s.set('GET /app/api/admin/agents/sales/prompt', () => ({ body: { ...PROMPT, modelId: model, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] } }));
    s.set('PUT /app/api/admin/agents/sales/model', (call) => ((model = (call.body as { modelId: string }).modelId), { body: { ok: true } }));
    renderApp('/admin/agents/sales');
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Промпт агента' }), ' Отвечай кратко.');
    await user.click(within(tabs()).getByRole('link', { name: 'Настройки' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Модель агента' }), 'GigaChat 2 Max');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Модель агента' })).toHaveValue('gigachat'));
    await user.click(within(tabs()).getByRole('link', { name: 'Значок' }));
    expect(await screen.findByRole('radiogroup', { name: 'Значок агента' })).toBeInTheDocument();
    await user.click(within(tabs()).getByRole('link', { name: 'Инструкции' }));
    expect(await screen.findByRole('textbox', { name: 'Промпт агента' })).toHaveValue('Ты агент продаж. Отвечай кратко.');
  });

  it('keeps the text typed after «Сохранить черновик» when the model changes, and shows the fresh version after publishing', async () => {
    let state: PromptState = { ...PROMPT, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] };
    const s = server(state);
    s.set('GET /app/api/admin/agents/sales/prompt', () => ({ body: state }));
    s.set('PUT /app/api/admin/agents/sales/prompt/draft', (call) => {
      state = { ...state, draftInstructions: (call.body as { text: string }).text, draftVersionId: 'v2', draftBy: 'Игорь' };
      return { body: { draftVersionId: 'v2' } };
    });
    s.set('PUT /app/api/admin/agents/sales/model', (call) => ((state = { ...state, modelId: (call.body as { modelId: string }).modelId }), { body: { ok: true } }));
    s.set('POST /app/api/admin/agents/sales/prompt/publish', () => {
      state = { ...state, publishedInstructions: 'Опубликованный промпт.', draftInstructions: null, draftVersionId: null, publishedAt: '2026-11-16T10:00:00Z' };
      return { body: { ok: true } };
    });
    renderApp('/admin/agents/sales');
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Промпт агента' });
    await user.type(field, ' Отвечай кратко.');
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    await screen.findByText('Черновик сохранён');
    await user.type(field, ' И вежливо.');
    await user.click(within(tabs()).getByRole('link', { name: 'Настройки' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Модель агента' }), 'GigaChat 2 Max');
    await waitFor(() => expect(s.calls.filter((c) => c.path.endsWith('/prompt')).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Модель агента' })).toHaveValue('gigachat'));
    await user.click(within(tabs()).getByRole('link', { name: 'Инструкции' }));
    expect(await screen.findByRole('textbox', { name: 'Промпт агента' })).toHaveValue('Ты агент продаж. Отвечай кратко. И вежливо.');

    await user.click(screen.getByRole('button', { name: 'Опубликовать' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Промпт агента' })).toHaveValue('Опубликованный промпт.'));
  });

  it('«Доступ»: opens the agent to departments and employees at once, or to the whole organisation', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/access', (call) => ({ body: { access: call.body } }));
    renderApp('/admin/agents/sales/access');
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Кому доступен агент' });
    expect(within(group).getByRole('button', { name: 'Отделы' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Сотрудники' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('checkbox', { name: 'Отдел продаж' })).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Сохранить доступ' })).not.toBeInTheDocument();
    // Employees by name next to the department.
    await user.click(within(group).getByRole('button', { name: 'Сотрудники' }));
    await user.click(screen.getByRole('checkbox', { name: 'Пётр Иванов' }));
    expect(screen.getByRole('checkbox', { name: 'Отдел продаж' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Сохранить доступ' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/access'))?.body).toEqual({ org: false, departmentIds: [D1], userIds: ['u2'] }));
    // The whole organisation leaves no lists.
    await user.click(within(group).getByRole('button', { name: 'Вся организация' }));
    expect(screen.queryByRole('checkbox', { name: 'Отдел продаж' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сохранить доступ' }));
    await waitFor(() => expect(s.calls.filter((c) => c.path.endsWith('/access')).at(-1)?.body).toEqual({ org: true, departmentIds: [], userIds: [] }));
  });

  it('«Доступ»: closing a list forgets what was ticked in it', async () => {
    const s = server(PROMPT, [{ ...AGENT, access: { org: false, departmentIds: [D1], userIds: ['u2'] } }]);
    s.set('PUT /app/api/admin/agents/sales/access', (call) => ({ body: { access: call.body } }));
    renderApp('/admin/agents/sales/access');
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Кому доступен агент' });
    await user.click(within(group).getByRole('button', { name: 'Отделы' }));
    expect(screen.queryByRole('checkbox', { name: 'Отдел продаж' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сохранить доступ' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/access'))?.body).toEqual({ org: false, departmentIds: [], userIds: ['u2'] }));
  });

  it('«Доступ»: an agent open to everyone shows only «Вся организация», even with a department left from its card', async () => {
    const s = server(PROMPT, [{ ...AGENT, access: { org: true, departmentIds: [D1], userIds: [] } }]);
    s.set('PUT /app/api/admin/agents/sales/access', (call) => ({ body: { access: call.body } }));
    renderApp('/admin/agents/sales/access');
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Кому доступен агент' });
    expect(within(group).getByRole('button', { name: 'Вся организация' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Отделы' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('checkbox', { name: 'Отдел продаж' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить доступ' })).not.toBeInTheDocument();
    expect(screen.getByText(/Агент открыт всем сотрудникам/)).toBeInTheDocument();
    expect(screen.getByText('Вся организация', { selector: 'p' })).toBeInTheDocument();
    // Choosing departments instead is a change to save, the department kept.
    await user.click(within(group).getByRole('button', { name: 'Отделы' }));
    expect(screen.getByRole('checkbox', { name: 'Отдел продаж' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Отдел продаж' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить доступ' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/access'))?.body).toEqual({ org: false, departmentIds: [D1], userIds: [] }));
  });

  it('«Скиллы»: ticks the skills of the base for the agent; the system ones are always on', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/skills', (call) => ({ body: call.body }));
    renderApp('/admin/agents/sales/skills');
    const user = userEvent.setup();
    expect(await screen.findByRole('checkbox', { name: 'Коммерческое предложение' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Проверка договора' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Документы Word' })).not.toBeInTheDocument();
    expect(screen.getByText(/Документы Word/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Проверка договора' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить скиллы' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/skills') && c.method === 'PUT')?.body).toEqual({ skillNames: ['kp-builder', 'contract-check'] }));
  });

  it('«Скиллы»: says the system skills are off with the commands and leads to «Скиллы» when the base is empty', async () => {
    const s = server(PROMPT, [{ ...AGENT, skillNames: [], abilities: { web: true, commands: false, widgets: true } }]);
    s.set('GET /app/api/me', { body: { ...ADMIN, permissions: ['agents', 'skills'] } });
    s.set('GET /app/api/admin/skills', { body: { skills: [SKILLS[0]], sandbox: { programs: [], python: [], node: [] } } });
    renderApp('/admin/agents/sales/skills');
    expect(await screen.findByText(/выключены вместе с командами терминала/)).toBeInTheDocument();
    expect(screen.getByText(/В базе пока нет загруженных скиллов/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть «Скиллы»' })).toHaveAttribute('href', '/admin/skills');
  });

  it('says an agent is gone from the installation and leads back to the list', async () => {
    server();
    renderApp('/admin/agents/old-agent');
    expect(await screen.findByText('Такого агента нет в установке. Вернитесь к списку агентов.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Все агенты' })).toHaveAttribute('href', '/admin/agents');
  });
});
