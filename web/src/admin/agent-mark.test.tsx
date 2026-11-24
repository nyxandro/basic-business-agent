// «Значок» on the page of an agent (spec, section 8.17; decision of the owner 16.11): the agent's own
// icon or the admin's picture, saved as one form; the page and the list of agents show it at once.
import type { AgentMarkAdminState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, ME, mockServer, type Reply } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { prepareAgentImage } from './agent-image.ts';

// The browser's canvas is not in jsdom: the preparation of the picture is checked in e2e.
vi.mock('./agent-image.ts', async (original) => ({ ...(await original<typeof import('./agent-image.ts')>()), prepareAgentImage: vi.fn() }));

const ADMIN = { ...ME, permissions: ['agents'] };
const SPARK: AgentMarkAdminState = { kind: 'icon', icon: 'spark', image: null };
const PICTURE_URL = '/app/api/agents/sales/image?v=0123456789ab';
const PAGE = '/admin/agents/sales/mark';
const PUT = 'PUT /app/api/admin/agents/sales/mark';
const agent = (mark: AgentMarkAdminState) => ({ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', modelId: null, access: { org: false, departmentIds: [], userIds: [] }, skillNames: [], starters: [], startersCustom: false, promptChanged: false, mark });

function server(state: AgentMarkAdminState = SPARK, saved: AgentMarkAdminState = state, me: object = ADMIN) {
  let current = state;
  const s = mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/admin/agents': () => ({ body: { agents: [agent(current)], missingAgents: [] } }),
    'GET /app/api/admin/departments': { body: { departments: [] } },
    'GET /app/api/admin/people': { body: { people: [] } },
    'GET /app/api/admin/skills': { body: { skills: [], sandbox: { programs: [], python: [], node: [] } } },
    [PUT]: () => ((current = saved), { body: saved }),
  });
  return s;
}
const saveButton = () => screen.getByRole('button', { name: 'Сохранить' });
const puts = (s: ReturnType<typeof mockServer>) => s.calls.filter((c) => c.method === 'PUT' && c.path === '/app/api/admin/agents/sales/mark');

let createObjectURL = vi.fn((_: Blob) => 'blob:picture');
beforeEach(() => {
  let made = 0;
  const addressOf = (createObjectURL = vi.fn(() => `blob:picture-${++made}`));
  // jsdom has no addresses for files. A subclass, not the real URL changed: unstubbing brings it back.
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = addressOf;
      static override revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  vi.mocked(prepareAgentImage).mockReset();
});

describe('«Значок» of an agent', () => {
  it('offers an icon or the admin’s picture, no «Без значка»: that is the switch of «Интерфейс»', async () => {
    server();
    renderApp(PAGE);
    const kinds = await screen.findByRole('radiogroup', { name: 'Значок агента' });
    expect(within(kinds).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Иконка', 'Своя картинка']);
    expect(screen.queryByText(/значки в чате скрыты/)).not.toBeInTheDocument();
  });

  it('says the marks are hidden in the chat while «Интерфейс» hides them, with the way there for whoever may go', async () => {
    server(SPARK, SPARK, { ...ADMIN, permissions: ['agents', 'interface'], interface: { showAgentMark: false } });
    renderApp(PAGE);
    const note = await screen.findByText(/Сейчас значки в чате скрыты/);
    expect(within(note).getByRole('link', { name: 'Интерфейс' })).toHaveAttribute('href', '/admin/interface');
  });

  it('saves another icon for this agent and shows it in the list of agents', async () => {
    const s = server(SPARK, { ...SPARK, icon: 'bot' });
    renderApp(PAGE);
    const user = userEvent.setup();
    expect(await screen.findByRole('radio', { name: 'Иконка' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Искра' })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Робот' }));
    await user.click(saveButton());
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(puts(s).map((c) => c.form)).toEqual([{ kind: 'icon', icon: 'bot' }]);
    // The page reads the agents again: its head and the list show the new mark.
    await waitFor(() => expect(s.calls.filter((c) => c.path === '/app/api/admin/agents')).toHaveLength(2));
    expect(saveButton()).toBeDisabled();
  });

  it('does not save «Своя картинка» until a picture is chosen, then sends the prepared one', async () => {
    vi.mocked(prepareAgentImage).mockResolvedValue(new Blob(['webp'], { type: 'image/webp' }));
    const s = server(SPARK, { kind: 'image', icon: 'spark', image: { url: PICTURE_URL } });
    renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    expect(saveButton()).toBeDisabled();
    const photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Файл картинки'), photo);
    expect(prepareAgentImage).toHaveBeenCalledWith(photo);
    expect(await screen.findAllByRole('img', { name: 'Выбранная картинка' })).not.toHaveLength(0);
    await user.click(saveButton());
    await screen.findByText('Сохранено');
    expect(puts(s).map((c) => c.form)).toEqual([{ kind: 'image', icon: 'spark', image: 'agent.webp' }]);
  });

  it('shows the kept picture and switches back to it without a new upload', async () => {
    const s = server({ kind: 'icon', icon: 'spark', image: { url: PICTURE_URL } });
    renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    expect(screen.getAllByRole('img', { name: 'Выбранная картинка' })[0]).toHaveAttribute('src', PICTURE_URL);
    await user.click(saveButton());
    await screen.findByText('Сохранено');
    expect(puts(s).map((c) => c.form)).toEqual([{ kind: 'image', icon: 'spark' }]);
  });

  it('says why a file could not be opened and keeps the save closed', async () => {
    const { AgentImageError } = await import('./agent-image.ts');
    vi.mocked(prepareAgentImage).mockRejectedValue(new AgentImageError('unreadable'));
    server();
    renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['not a picture'], 'broken.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByText(/Не получилось открыть картинку/)).toBeInTheDocument();
    expect(screen.getByText(/APP_AGENT_IMAGE_INVALID/)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('says the browser could not prepare the picture, not that the server is down', async () => {
    const { AgentImageError } = await import('./agent-image.ts');
    vi.mocked(prepareAgentImage).mockRejectedValue(new AgentImageError('not-prepared', { cause: new Error('canvas.toBlob gave no picture') }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    server();
    renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['photo'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByText(/Браузер не смог подготовить картинку/)).toBeInTheDocument();
    expect(screen.getByText(/APP_AGENT_IMAGE_PREPARE_FAILED/)).toBeInTheDocument();
    expect(screen.queryByText(/Сервер/)).not.toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    expect(saveButton()).toBeDisabled();
  });

  it('makes no address for a picture that is ready after the admin left the page', async () => {
    let ready: (blob: Blob) => void = () => undefined;
    vi.mocked(prepareAgentImage).mockReturnValue(new Promise<Blob>((resolve) => (ready = resolve)));
    server();
    const page = renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('button', { name: 'Готовлю…' })).toBeDisabled();
    page.unmount();
    ready(new Blob(['webp'], { type: 'image/webp' }));
    await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps a picture chosen while the one before it is being saved', async () => {
    vi.mocked(prepareAgentImage).mockResolvedValueOnce(new Blob(['first'], { type: 'image/webp' })).mockResolvedValueOnce(new Blob(['second'], { type: 'image/webp' }));
    let answer: (reply: Reply) => void = () => undefined;
    const s = server();
    s.set(PUT, () => new Promise<Reply>((resolve) => (answer = resolve)));
    renderApp(PAGE);
    const user = userEvent.setup();
    const chosen = () => screen.getByRole('img', { name: 'Выбранная картинка' });
    await user.click(await screen.findByRole('radio', { name: 'Своя картинка' }));
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['1'], 'first.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(chosen()).toHaveAttribute('src', 'blob:picture-1'));
    await user.click(saveButton());
    await user.upload(screen.getByLabelText('Файл картинки'), new File(['2'], 'second.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(chosen()).toHaveAttribute('src', 'blob:picture-2'));
    answer({ body: { kind: 'image', icon: 'spark', image: { url: PICTURE_URL } } });
    await screen.findByText('Сохранено');
    // The first picture is saved; the second is still the choice and waits for its own «Сохранить».
    expect(chosen()).toHaveAttribute('src', 'blob:picture-2');
    expect(saveButton()).toBeEnabled();
  });

  it('keeps the choice when the server refuses, so it can be saved again', async () => {
    const s = server();
    s.set(PUT, apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500));
    renderApp(PAGE);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Молния' }));
    await user.click(saveButton());
    expect(await screen.findByText(/Что-то пошло не так на сервере/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Молния' })).toHaveAttribute('aria-checked', 'true');
    expect(saveButton()).toBeEnabled();
  });
});
