import type { PromptState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['agents'] };
const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки', modelId: null, departmentNames: ['Отдел продаж'], starters: ['Покажи мои сделки'], startersCustom: false, promptChanged: true, mark: { kind: 'icon', icon: 'headset', image: null }, abilities: { web: true, commands: true } };
const ASSISTANT = { ...AGENT, id: 'assistant', name: 'Общий помощник', description: 'Вопросы', departmentNames: [], promptChanged: false, mark: { kind: 'image', icon: 'spark', image: { url: '/app/api/agents/assistant/image?v=0123456789ab' } } };
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
};

function server(prompt: object = PROMPT, agents: object[] = [AGENT], missing: string[] = []) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/agents': { body: { agents, missingAgents: missing } },
    'GET /app/api/admin/tasks': { body: { tasks: [] } },
    'GET /app/api/admin/agents/sales/prompt': { body: prompt },
  });
}

const tabs = () => screen.getByRole('navigation', { name: 'Разделы агента' });

describe('«Агенты и промпты»: the list', () => {
  it('lists the agents with their marks, departments and an edited prompt; a click opens the agent’s page', async () => {
    server(PROMPT, [AGENT, ASSISTANT]);
    renderApp('/admin/agents');
    const list = await screen.findByRole('list', { name: 'Агенты' });
    const rows = within(list).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/admin/agents/sales', '/admin/agents/assistant']);
    expect(within(rows[0]!).getByText('Отдел продаж')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Изменён в админке')).toBeInTheDocument();
    expect(rows[0]!.querySelector('[data-agent-mark="icon"]')).toHaveAttribute('data-icon', 'headset');
    expect(within(rows[1]!).getByText('Не назначен отделам')).toBeInTheDocument();
    expect(rows[1]!.querySelector('[data-agent-mark="image"] img')).toHaveAttribute('src', ASSISTANT.mark.image.url);
    // No editor on the list: the prompt is on the agent's page.
    expect(screen.queryByRole('textbox', { name: 'Промпт агента' })).not.toBeInTheDocument();

    await userEvent.setup().click(rows[0]!);
    expect(await screen.findByRole('heading', { name: 'Продажи', level: 1 })).toBeInTheDocument();
    expect(within(tabs()).getAllByRole('link').map((l) => l.textContent)).toEqual(['Инструкции', 'Настройки', 'Значок']);
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
    expect(screen.getByText('Отдел продаж')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Проверить в чате' })).toHaveAttribute('href', '/admin/agents/sales/check');
    // The model and the starters are in «Настройки».
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

  it('«Настройки»: saves the starter questions and brings back those of the file', async () => {
    const s = server(PROMPT, [{ ...AGENT, starters: ['Сводка'], startersCustom: true }]);
    s.set('PUT /app/api/admin/agents/sales/starters', { body: { ok: true } });
    renderApp('/admin/agents/sales/settings');
    const user = userEvent.setup();
    expect(within(await screen.findByRole('navigation', { name: 'Разделы агента' })).getByRole('link', { name: 'Настройки' })).toHaveAttribute('aria-current', 'page');
    const field = await screen.findByRole('textbox', { name: 'Подсказки в пустом чате' });
    await user.clear(field);
    await user.type(field, 'Сделки без движения; Сводка по воронке');
    await user.click(screen.getByRole('button', { name: 'Сохранить подсказки' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/starters'))?.body).toEqual({ starters: ['Сделки без движения', 'Сводка по воронке'] }));
    await user.click(screen.getByRole('button', { name: 'Вернуть подсказки из файла' }));
    await waitFor(() => expect(s.calls.filter((c) => c.path.endsWith('/starters')).at(-1)?.body).toEqual({ starters: null }));
  });

  it('«Настройки»: «Что агенту можно» saves a switch at once and keeps it as it was when the server fails', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/abilities', { body: { abilities: { web: false, commands: true } } });
    renderApp('/admin/agents/sales/settings');
    const user = userEvent.setup();
    const web = await screen.findByRole('switch', { name: 'Доступ к сети интернет' });
    const commands = screen.getByRole('switch', { name: 'Доступ к выполнению команд терминала' });
    expect(web).toHaveAttribute('aria-checked', 'true');
    expect(commands).toHaveAttribute('aria-checked', 'true');
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

  it('says an agent is gone from the installation and leads back to the list', async () => {
    server();
    renderApp('/admin/agents/old-agent');
    expect(await screen.findByText('Такого агента нет в установке. Вернитесь к списку агентов.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Все агенты' })).toHaveAttribute('href', '/admin/agents');
  });
});
