import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer, type MockCall } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, permissions: ['skills'] };
const DEPARTMENTS = [{ id: '00000000-0000-4000-8000-0000000000d1', name: 'Отдел продаж', userIds: [], agentIds: [] }];
const SKILL = {
  name: 'contract-check',
  title: 'Проверка договора',
  description: 'Сроки, штрафы, порядок приёмки.',
  sizeBytes: 4096,
  files: [{ path: 'SKILL.md', bytes: 2048 }],
  hasScripts: false,
  enabled: true,
  access: { scope: 'org', departmentIds: [], userIds: [] },
  uploadedAt: '2026-11-12T08:00:00Z',
  uploadedBy: 'Игорь',
};
const PREVIEW = { name: 'kp-builder', title: 'Коммерческое предложение', description: 'Собирает КП по шаблону.', sizeBytes: 8192, files: [{ path: 'SKILL.md', bytes: 1024 }, { path: 'scripts/build.py', bytes: 2048 }], hasScripts: true, exists: false };

function server(skills: object[] = [SKILL]) {
  return mockServer({
    'GET /app/api/me': { body: ADMIN },
    'GET /app/api/admin/skills': { body: { skills, libraries: ['pandas', 'openpyxl'] } },
    'GET /app/api/admin/departments': { body: { departments: DEPARTMENTS } },
    'GET /app/api/admin/users': { body: { users: [] } },
  });
}

const posts = (s: { calls: MockCall[] }) => s.calls.filter((c) => c.method === 'POST' && c.path === '/app/api/admin/skills');

describe('«Скиллы»', () => {
  it('checks the file first, then saves it for the chosen department', async () => {
    const s = server();
    s.set('POST /app/api/admin/skills', (call) => (call.query.check === '1' ? { body: PREVIEW } : { status: 201, body: { ...PREVIEW, enabled: true, access: JSON.parse(call.form!.access!) as object, uploadedAt: '', uploadedBy: null } }));
    renderApp('/admin/skills');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Добавить скилл' }));
    const dialog = screen.getByRole('dialog', { name: 'Добавить скилл' });
    await user.upload(within(dialog).getByLabelText('Файл скилла'), new File(['zip'], 'kp-builder.skill'));
    expect(await within(dialog).findByText('Коммерческое предложение')).toBeInTheDocument();
    expect(within(dialog).getByText(/Есть скрипты/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Отделы' }));
    expect(within(dialog).getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Отдел продаж' }));
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Скилл добавлен')).toBeInTheDocument();
    const saved = posts(s).at(-1)!;
    expect(saved.query).toEqual({});
    expect(JSON.parse(saved.form!.access!)).toEqual({ scope: 'departments', departmentIds: [DEPARTMENTS[0]!.id], userIds: [] });
    expect(saved.form!.file).toBe('kp-builder.skill');
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

  it('shows who has a skill and the sandbox libraries', async () => {
    server([{ ...SKILL, access: { scope: 'departments', departmentIds: [DEPARTMENTS[0]!.id], userIds: [] } }]);
    renderApp('/admin/skills');
    expect(await screen.findByText('Отделы: Отдел продаж')).toBeInTheDocument();
    expect(screen.getByText(/pandas, openpyxl/)).toBeInTheDocument();
  });
});
