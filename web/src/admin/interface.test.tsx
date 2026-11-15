// «Интерфейс» (spec, section 8.17): the agent's mark for all agents — an icon, the admin's picture
// or none — saved as one form; the admin's own chat changes at once.
import type { InterfaceAdminState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { prepareAgentImage } from './agent-image.ts';

// The browser's canvas is not in jsdom: the preparation of the picture is checked in e2e.
vi.mock('./agent-image.ts', async (original) => ({ ...(await original<typeof import('./agent-image.ts')>()), prepareAgentImage: vi.fn() }));

const ADMIN = { ...ME, permissions: ['interface'] };
const SPARK: InterfaceAdminState = { agentMark: 'icon', agentIcon: 'spark', image: null };
const PICTURE_URL = '/app/api/interface/agent-image?v=0123456789ab';

function server(state: InterfaceAdminState = SPARK, saved: InterfaceAdminState = state) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/interface': { body: state },
    'PUT /app/api/admin/interface': { body: saved },
  });
}
const saveButton = () => screen.getByRole('button', { name: 'Сохранить' });
const puts = (s: ReturnType<typeof mockServer>) => s.calls.filter((c) => c.method === 'PUT' && c.path === '/app/api/admin/interface');

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:picture'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.mocked(prepareAgentImage).mockReset();
});

describe('«Интерфейс»', () => {
  it('is in the menu only for a person with its right', async () => {
    server();
    const first = renderApp('/admin/interface');
    expect(await screen.findByRole('heading', { name: 'Интерфейс' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Разделы админки' })).getByRole('link', { name: 'Интерфейс' })).toBeInTheDocument();
    first.unmount();
    mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['users'] } }, 'GET /app/api/admin/users': { body: { users: [] } } });
    renderApp('/admin/users');
    expect(await screen.findByRole('navigation', { name: 'Разделы админки' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Интерфейс' })).not.toBeInTheDocument();
  });

  it('saves another icon and refreshes the admin’s own chat', async () => {
    const s = server(SPARK, { ...SPARK, agentIcon: 'bot' });
    renderApp('/admin/interface');
    const user = userEvent.setup();
    expect(await screen.findByRole('radio', { name: 'Иконка' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Искра' })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Робот' }));
    await user.click(saveButton());
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(puts(s).map((c) => c.form)).toEqual([{ agentMark: 'icon', agentIcon: 'bot' }]);
    await waitFor(() => expect(s.calls.filter((c) => c.path === '/app/api/me')).toHaveLength(2));
    expect(saveButton()).toBeDisabled();
  });

  it('saves «Без значка», keeping the last icon for a way back', async () => {
    const s = server({ ...SPARK, agentIcon: 'star' }, { agentMark: 'none', agentIcon: 'star', image: null });
    renderApp('/admin/interface');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Без значка' }));
    expect(screen.getByText('Ответы агента начинаются от левого края, без значка.')).toBeInTheDocument();
    await user.click(saveButton());
    await screen.findByText('Сохранено');
    expect(puts(s).map((c) => c.form)).toEqual([{ agentMark: 'none', agentIcon: 'star' }]);
  });

  it('does not save «Своя картинка» until a picture is chosen, then sends the prepared one', async () => {
    vi.mocked(prepareAgentImage).mockResolvedValue(new Blob(['webp'], { type: 'image/webp' }));
    const s = server(SPARK, { agentMark: 'image', agentIcon: 'spark', image: { url: PICTURE_URL } });
    renderApp('/admin/interface');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    expect(saveButton()).toBeDisabled();
    const photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Файл картинки'), photo);
    expect(prepareAgentImage).toHaveBeenCalledWith(photo);
    expect(await screen.findAllByRole('img', { name: 'Выбранная картинка' })).not.toHaveLength(0);
    await user.click(saveButton());
    await screen.findByText('Сохранено');
    expect(puts(s).map((c) => c.form)).toEqual([{ agentMark: 'image', agentIcon: 'spark', image: 'agent.webp' }]);
  });

  it('shows the kept picture and switches back to it without a new upload', async () => {
    const s = server({ agentMark: 'icon', agentIcon: 'spark', image: { url: PICTURE_URL } });
    renderApp('/admin/interface');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    expect(screen.getAllByRole('img', { name: 'Выбранная картинка' })[0]).toHaveAttribute('src', PICTURE_URL);
    await user.click(saveButton());
    await screen.findByText('Сохранено');
    expect(puts(s).map((c) => c.form)).toEqual([{ agentMark: 'image', agentIcon: 'spark' }]);
  });

  it('says why a file could not be opened and keeps the save closed', async () => {
    const { AgentImageError } = await import('./agent-image.ts');
    vi.mocked(prepareAgentImage).mockRejectedValue(new AgentImageError('unreadable'));
    server();
    renderApp('/admin/interface');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['not a picture'], 'broken.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText(/Не получилось открыть картинку/)).toBeInTheDocument();
    expect(screen.getByText(/APP_AGENT_IMAGE_INVALID/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('keeps the choice when the server refuses, so it can be saved again', async () => {
    const s = server();
    s.set('PUT /app/api/admin/interface', apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500));
    renderApp('/admin/interface');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Молния' }));
    await user.click(saveButton());
    expect(await screen.findByText(/Что-то пошло не так на сервере/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Молния' })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeEnabled();
  });
});
