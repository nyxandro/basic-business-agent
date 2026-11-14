import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, user: { id: 'u0', email: 'igor@example.com', name: 'Игорь' }, isSuperadmin: true, permissions: ['users', 'roles', 'departments', 'limits', 'usage', 'agents', 'org_profile', 'masking', 'connections', 'journal'] };

describe('agent prompt', () => {
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
    allowedModels: [],
  };

  it('keeps the typed text when someone else changed the prompt meanwhile', async () => {
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/agents': { body: { agents: [{ id: 'sales', name: 'Продажи', description: 'Сделки', modelId: null }], missingAgents: [] } },
      'GET /app/api/admin/tasks': { body: { tasks: [] } },
      'GET /app/api/admin/agents/sales/prompt': { body: PROMPT },
      'PUT /app/api/admin/agents/sales/prompt/draft': apiError('APP_AGENT_DRAFT_CONFLICT', 'Пока вы редактировали, промпт изменил(а) Ольга. Скопируйте свой текст, обновите страницу и внесите правку в свежую версию.', 409),
    });
    renderApp('/admin/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Промпт' }));
    const field = await screen.findByRole('textbox', { name: 'Промпт агента' });
    await user.type(field, ' Отвечай кратко.');
    await user.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
    expect(await screen.findByText(/промпт изменил\(а\) Ольга/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Промпт агента' })).toHaveValue('Ты агент продаж. Отвечай кратко.');
  });

  it('marks a prompt changed in the admin panel and a file changed after that', async () => {
    mockServer({
      'GET /app/api/me': { body: ADMIN },
      'GET /app/api/admin/agents': { body: { agents: [{ id: 'sales', name: 'Продажи', description: 'Сделки', modelId: null }], missingAgents: ['old-agent'] } },
      'GET /app/api/admin/tasks': { body: { tasks: [] } },
      'GET /app/api/admin/agents/sales/prompt': { body: { ...PROMPT, publishedInstructions: 'Правка', publishedAt: '2026-11-14T08:00:00.000Z', fileChangedSincePublish: true } },
    });
    renderApp('/admin/agents');
    expect(await screen.findByText(/old-agent/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Промпт' }));
    expect(await screen.findByText('Изменён в админке')).toBeInTheDocument();
    expect(screen.getByText('Файл изменён после правки в админке')).toBeInTheDocument();
  });
});

describe('masking and invites', () => {
  it('saves the switches of what the model must not see', async () => {
    const server = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/masking': { body: { kinds: ['passport', 'snils'] } }, 'PUT /app/api/admin/masking': { body: { ok: true } } });
    renderApp('/admin/masking');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Электронная почта' }));
    await user.click(screen.getByRole('checkbox', { name: 'СНИЛС' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === 'PUT')?.body).toEqual({ kinds: ['passport', 'email'] });
  });
});
