import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer, type MockCall } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['skills'] };
const agent = (id: string, name: string) => ({ id, name, description: '', modelId: null, access: { org: false, departmentIds: [], userIds: [] }, skillNames: [], promptChanged: false, mark: { kind: 'icon', icon: 'spark', image: null }, abilities: { web: true, commands: true, widgets: true } });
const AGENTS = [agent('sales', 'Продажи'), agent('assistant', 'Общий помощник')];
const SKILL = {
  name: 'contract-check',
  title: 'Проверка договора',
  description: 'Сроки, штрафы, порядок приёмки.',
  sizeBytes: 4096,
  files: [{ path: 'SKILL.md', bytes: 2048 }],
  hasScripts: false,
  enabled: true,
  agentIds: ['sales'],
  system: false,
  uploadedAt: '2026-11-12T08:00:00Z',
  uploadedBy: 'Игорь',
};
// A system skill of the core (spec, section 8.18): always on, nothing to change.
const SYSTEM = {
  name: 'docx',
  title: 'Документы Word',
  description: 'Читает, создаёт и правит документы Word.',
  sizeBytes: 300_000,
  files: [{ path: 'SKILL.md', bytes: 7442 }],
  hasScripts: true,
  enabled: true,
  agentIds: [],
  system: true,
  uploadedAt: null,
  uploadedBy: null,
};
const SANDBOX = { programs: ['LibreOffice', 'pandoc'], python: ['pandas', 'openpyxl'], node: ['docx', 'pptxgenjs'] };
const PREVIEW = { name: 'kp-builder', title: 'Коммерческое предложение', description: 'Собирает КП по шаблону.', sizeBytes: 8192, files: [{ path: 'SKILL.md', bytes: 1024 }, { path: 'scripts/build.py', bytes: 2048 }], hasScripts: true, exists: false };

function server(skills: object[] = [SYSTEM, SKILL]) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/skills': { body: { skills, sandbox: SANDBOX } },
    'GET /app/api/admin/agents': { body: { agents: AGENTS, missingAgents: [] } },
  });
}

const posts = (s: { calls: MockCall[] }) => s.calls.filter((c) => c.method === 'POST' && c.path === '/app/api/admin/skills');

describe('«Скиллы»', () => {
  it('checks the file first, then saves it with the agents ticked — none ticked at the start', async () => {
    const s = server();
    s.set('POST /app/api/admin/skills', (call) => (call.query.check === '1' ? { body: PREVIEW } : { status: 201, body: { ...PREVIEW, enabled: true, agentIds: JSON.parse(call.form!.agentIds!) as string[], system: false, uploadedAt: '', uploadedBy: null } }));
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить скилл' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить скилл' });
    await user.upload(within(dialog).getByLabelText('Файл скилла'), new File(['zip'], 'kp-builder.skill'));
    expect(await within(dialog).findByText('Коммерческое предложение')).toBeInTheDocument();
    expect(within(dialog).getByText(/Есть скрипты/)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Продажи' })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Общий помощник' })).not.toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Продажи' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Скилл добавлен')).toBeInTheDocument();
    const saved = posts(s).at(-1)!;
    expect(saved.query).toEqual({});
    expect(JSON.parse(saved.form!.agentIds!)).toEqual(['sales']);
    expect(saved.form!.file).toBe('kp-builder.skill');
  });

  it('saves a skill with no agent: it waits until agents are ticked', async () => {
    const s = server();
    s.set('POST /app/api/admin/skills', (call) => (call.query.check === '1' ? { body: PREVIEW } : { status: 201, body: { ...PREVIEW, enabled: true, agentIds: [], system: false, uploadedAt: '', uploadedBy: null } }));
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить скилл' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить скилл' });
    await user.upload(within(dialog).getByLabelText('Файл скилла'), new File(['zip'], 'kp-builder.skill'));
    expect(await within(dialog).findByText(/Пока агенты не отмечены, скилл никто не использует/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Скилл добавлен')).toBeInTheDocument();
    expect(JSON.parse(posts(s).at(-1)!.form!.agentIds!)).toEqual([]);
  });

  it('changes the agents of a skill from its menu', async () => {
    const s = server();
    s.set('PUT /app/api/admin/skills/contract-check', { body: { ...SKILL, agentIds: ['assistant', 'sales'] } });
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Действия: Проверка договора' }));
    await user.click(screen.getByRole('menuitem', { name: 'Агенты' }));
    const dialog = screen.getByRole('dialog', { name: 'Агенты: Проверка договора' });
    expect(within(dialog).getByRole('checkbox', { name: 'Продажи' })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Общий помощник' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ agentIds: ['sales', 'assistant'] }));
  });

  it('says why an archive is refused', async () => {
    const s = server();
    s.set('POST /app/api/admin/skills', apiError('APP_SKILL_INVALID', 'В архиве нет файла SKILL.md. Соберите скилл заново.', 400));
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить скилл' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить скилл' });
    await user.upload(within(dialog).getByLabelText('Файл скилла'), new File(['zip'], 'broken.skill'));
    expect(await within(dialog).findByText('В архиве нет файла SKILL.md. Соберите скилл заново.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  });

  it('replaces a skill of the same name with the new version', async () => {
    const s = server();
    s.set('POST /app/api/admin/skills', { body: { ...PREVIEW, name: 'contract-check', title: 'Проверка договора', exists: true } });
    s.set('PUT /app/api/admin/skills/contract-check', { body: SKILL });
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить скилл' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить скилл' });
    await user.upload(within(dialog).getByLabelText('Файл скилла'), new File(['zip'], 'contract-check.skill'));
    expect(await within(dialog).findByText(/заменит его новой версией/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Заменить' }));
    expect(await screen.findByText('Скилл заменён')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.form?.file).toBe('contract-check.skill');
  });

  it('turns a skill off with its switch and removes one after the question', async () => {
    const s = server();
    s.set('PUT /app/api/admin/skills/contract-check', { body: { ...SKILL, enabled: false } });
    s.set('DELETE /app/api/admin/skills/contract-check', { body: { ok: true } });
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Проверка договора' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false }));
    await user.click(screen.getByRole('button', { name: 'Действия: Проверка договора' }));
    await user.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить скилл «Проверка договора»?' });
    await user.click(within(question).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('shows the agents of a skill, marks one with none, and what the sandbox has', async () => {
    // An agent the installation no longer has is not named.
    server([SYSTEM, { ...SKILL, agentIds: ['assistant', 'archived', 'sales'] }, { ...SKILL, name: 'kp-builder', title: 'Коммерческое предложение', agentIds: [] }]);
    renderApp('/admin/skills');
    expect(await screen.findByText('Продажи, Общий помощник')).toBeInTheDocument();
    expect(screen.getByText('не выбраны — скилл никто не использует')).toBeInTheDocument();
    expect(screen.getByText(/Программы: LibreOffice, pandoc/)).toBeInTheDocument();
    expect(screen.getByText(/Библиотеки Python: pandas, openpyxl/)).toBeInTheDocument();
    expect(screen.getByText(/Пакеты Node: docx, pptxgenjs/)).toBeInTheDocument();
  });

  it('shows a system skill as built into the core: no switch, no actions, with every agent', async () => {
    server();
    renderApp('/admin/skills');
    // The card: the head of the skill and what follows it.
    const card = (await screen.findByText('Документы Word')).closest('[data-skill]')!.parentElement!;
    expect(within(card).getByText('Системный')).toBeInTheDocument();
    expect(within(card).getByText('все, которым можно выполнять команды')).toBeInTheDocument();
    expect(within(card).getByText(/Встроен в ядро/)).toBeInTheDocument();
    expect(within(card).queryByRole('switch')).toBeNull();
    expect(within(card).queryByRole('button', { name: /Действия/ })).toBeNull();
    // The skill uploaded by the admin keeps its switch and actions.
    expect(screen.getByRole('switch', { name: 'Проверка договора' })).toBeInTheDocument();
  });

  it('says there are no own skills yet while the system ones are there', async () => {
    server([SYSTEM]);
    renderApp('/admin/skills');
    expect(await screen.findByText('Документы Word')).toBeInTheDocument();
    expect(screen.getByText('Своих скиллов пока нет')).toBeInTheDocument();
  });
});
