import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['agents'] };
const AGENT = { id: 'sales', name: 'Продажи', description: 'Сделки', modelId: null, departmentNames: ['Отдел продаж'], starters: ['Покажи мои сделки'], startersCustom: false, promptChanged: true };
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

describe('«Агенты и промпты»', () => {
  it('shows how the prompt is put together, the project layer included, and the agent’s departments', async () => {
    server();
    renderApp('/admin/agents');
    const layers = await screen.findByRole('list', { name: 'Слои промпта' });
    expect(within(layers).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Правила ядра', 'Промпт агента', 'Профиль организации', 'Профиль сотрудника', 'Проект', 'Личная память']);
    expect(screen.getByText('Отдел продаж')).toBeInTheDocument();
    expect(screen.getAllByText('Изменён в админке').length).toBeGreaterThan(0);
  });

  it('keeps the typed text when someone else changed the prompt meanwhile', async () => {
    const s = server();
    s.set('PUT /app/api/admin/agents/sales/prompt/draft', apiError('APP_AGENT_DRAFT_CONFLICT', 'Пока вы редактировали, промпт изменил(а) Ольга. Скопируйте свой текст, обновите страницу и внесите правку в свежую версию.', 409));
    renderApp('/admin/agents');
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Промпт агента' });
    await user.type(field, ' Отвечай кратко.');
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    expect(await screen.findByText(/промпт изменил\(а\) Ольга/)).toBeInTheDocument();
    expect(field).toHaveValue('Ты агент продаж. Отвечай кратко.');
  });

  it('saves the starter questions and brings back those of the file', async () => {
    const s = server(PROMPT, [{ ...AGENT, starters: ['Сводка'], startersCustom: true }]);
    s.set('PUT /app/api/admin/agents/sales/starters', { body: { ok: true } });
    renderApp('/admin/agents');
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Подсказки в пустом чате' });
    await user.clear(field);
    await user.type(field, 'Сделки без движения; Сводка по воронке');
    await user.click(screen.getByRole('button', { name: 'Сохранить подсказки' }));
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/starters'))?.body).toEqual({ starters: ['Сделки без движения', 'Сводка по воронке'] }));
    await user.click(screen.getByRole('button', { name: 'Вернуть подсказки из файла' }));
    await waitFor(() => expect(s.calls.filter((c) => c.path.endsWith('/starters')).at(-1)?.body).toEqual({ starters: null }));
  });

  it('keeps the agent’s model inactive while agents may not choose one, and saves a choice otherwise', async () => {
    const first = server();
    const view = renderApp('/admin/agents');
    const off = await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(off).toBeDisabled();
    expect(screen.getByText(/включите «Агенты выбирают модель из каталога»/)).toBeInTheDocument();
    view.unmount();
    void first;

    const s = server({ ...PROMPT, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] });
    s.set('PUT /app/api/admin/agents/sales/model', { body: { ok: true } });
    renderApp('/admin/agents');
    const on = await screen.findByRole('combobox', { name: 'Модель агента' });
    expect(on).toBeEnabled();
    await userEvent.setup().selectOptions(on, 'GigaChat 2 Max');
    await waitFor(() => expect(s.calls.find((c) => c.path.endsWith('/model'))?.body).toEqual({ modelId: 'gigachat' }));
  });

  it('keeps the unsaved prompt when the model of the agent changes', async () => {
    let model: string | null = null;
    const s = server({ ...PROMPT, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] });
    s.set('GET /app/api/admin/agents/sales/prompt', () => ({ body: { ...PROMPT, modelId: model, allowedModels: [{ id: 'gigachat', label: 'GigaChat 2 Max' }] } }));
    s.set('PUT /app/api/admin/agents/sales/model', (call) => ((model = (call.body as { modelId: string }).modelId), { body: { ok: true } }));
    renderApp('/admin/agents');
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Промпт агента' });
    await user.type(field, ' Отвечай кратко.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Модель агента' }), 'GigaChat 2 Max');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Модель агента' })).toHaveValue('gigachat'));
    expect(screen.getByRole('textbox', { name: 'Промпт агента' })).toHaveValue('Ты агент продаж. Отвечай кратко.');
  });

  it('names agents departments point at but the installation lost', async () => {
    server(PROMPT, [AGENT], ['old-agent']);
    renderApp('/admin/agents');
    expect(await screen.findByText(/old-agent/)).toBeInTheDocument();
  });
});
