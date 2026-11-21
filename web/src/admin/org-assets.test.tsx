// «Бланк, печать и подпись» in «Профиль организации» (docs/specs/[20.11.2026]-org-letterhead.md, step 6): the letterhead
// with its hint, pictures prepared in the browser and saved after a look, the director, the responsible people — the
// stamp, the signature and the people only for a superadmin.
import type { OrgAssetsState } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { prepareOrgImage } from './stamp-image.ts';

// The browser's canvas is not in jsdom: what it does to the points is in stamp-image.test.ts.
vi.mock('./stamp-image.ts', async (original) => ({ ...(await original<typeof import('./stamp-image.ts')>()), prepareOrgImage: vi.fn() }));

const SUPERADMIN = { ...ME, isSuperadmin: true, permissions: ['org_profile', 'users'] };
const PROFILER = { ...ME, isSuperadmin: false, permissions: ['org_profile'] };
const PICTURE = { width: 400, height: 400, updatedAt: '2026-11-21T10:00:00.000Z', version: '0123456789ab' };
const DIRECTOR = { position: 'Генеральный директор', fullName: 'Иванов Иван Петрович', signatureName: 'И. П. Иванов' };
const EMPTY: OrgAssetsState = { blank: null, logo: null, director: { position: '', fullName: '', signatureName: '' }, signatureOutdated: false, seal: { stamp: null, signature: null, signers: [] } };

function server(me: object, state: OrgAssetsState) {
  let current = state;
  const reply = (next: OrgAssetsState) => ((current = next), { body: next });
  const s = mockServer({
    'GET /app/api/me': { body: me },
    'GET /app/api/admin/org-profile': { body: { name: 'Альфа-Строй', tone: '', requisites: '', industry: '' } },
    'GET /app/api/admin/org-assets': () => ({ body: current }),
    'GET /app/api/admin/people': { body: { people: [{ id: 'olga', name: 'Ольга Смирнова' }, { id: 'petr', name: 'Пётр' }] } },
  });
  return { s, reply };
}

const pick = (title: string) => screen.findByLabelText(`${title}: выбрать файл`);

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:prepared');
      static override revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  vi.mocked(prepareOrgImage).mockReset();
});

describe('«Бланк, печать и подпись»', () => {
  it('says how to keep a letterhead drawn in the body, warns of a signature of the former director and that nobody is responsible', async () => {
    server(SUPERADMIN, {
      ...EMPTY,
      blank: { fileName: 'Бланк Альфа-Строй.docx', updatedAt: PICTURE.updatedAt, info: { mark: false, header: false, bodyDrawing: true } },
      director: { ...DIRECTOR, fullName: 'Петров Пётр Петрович', signatureName: 'П. П. Петров' },
      seal: { stamp: PICTURE, signature: { ...PICTURE, director: 'Иванов Иван Петрович' }, signers: [] },
    });
    renderApp('/admin/org-profile');
    expect(await screen.findByText('Бланк Альфа-Строй.docx')).toBeInTheDocument();
    expect(screen.getByText(/Поставьте в бланке отдельной строкой \[\[ТЕКСТ\]\]/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Так начнётся документ агента' })).toBeInTheDocument();
    expect(screen.getByText(/руководителем был Иванов Иван Петрович\. Загрузите подпись нового руководителя/)).toBeInTheDocument();
    expect(screen.getByText(/печать и подпись хранятся картинками/)).toBeInTheDocument();
    expect(screen.getByText('Никто не назначен — печать и подпись через агента не ставятся.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Печать' })).toHaveAttribute('src', '/app/api/admin/org-assets/stamp/file?v=0123456789ab');
  });

  it('shows whoever is not a superadmin no stamp, signature or people — only who uploads them', async () => {
    server(PROFILER, { ...EMPTY, seal: null });
    renderApp('/admin/org-profile');
    expect(await screen.findByText('Загружает суперадминистратор.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Печать: выбрать файл')).not.toBeInTheDocument();
    expect(screen.queryByText('Ответственные лица — печать и подпись')).not.toBeInTheDocument();
    expect(await pick('Логотип — для презентаций, таблиц и документов без бланка')).toBeInTheDocument();
  });

  it('uploads the letterhead as it is and shows its name', async () => {
    const { s, reply } = server(SUPERADMIN, EMPTY);
    s.set('PUT /app/api/admin/org-assets/blank', () => reply({ ...EMPTY, blank: { fileName: 'Бланк.docx', updatedAt: PICTURE.updatedAt, info: { mark: false, header: true, bodyDrawing: false } } }));
    renderApp('/admin/org-profile');
    const user = userEvent.setup();
    await user.upload(await pick('Бланк (Word)'), new File(['PK'], 'Бланк.docx'));
    expect(await screen.findByText('Бланк.docx')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PUT')?.form).toEqual({ file: 'Бланк.docx' });
    // A letterhead with its header in the headers needs no hint.
    expect(screen.queryByText(/Поставьте в бланке отдельной строкой/)).not.toBeInTheDocument();
  });

  it('prepares a scan of the stamp without the white, shows it before saving and sends the PNG only on «Сохранить»', async () => {
    const { s, reply } = server(SUPERADMIN, EMPTY);
    s.set('PUT /app/api/admin/org-assets/stamp', () => reply({ ...EMPTY, seal: { stamp: PICTURE, signature: null, signers: [] } }));
    vi.mocked(prepareOrgImage).mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    renderApp('/admin/org-profile');
    const user = userEvent.setup();
    const scan = new File(['scan'], 'печать.jpg', { type: 'image/jpeg' });
    await user.upload(await pick('Печать'), scan);
    expect(prepareOrgImage).toHaveBeenCalledWith(scan, 'stamp', true);
    expect(await screen.findByRole('img', { name: 'Печать' })).toHaveAttribute('src', 'blob:prepared');
    expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(within(screen.getByRole('group', { name: 'Печать' })).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.form).toEqual({ file: 'stamp.png' }));
    expect(await screen.findByRole('img', { name: 'Печать' })).toHaveAttribute('src', '/app/api/admin/org-assets/stamp/file?v=0123456789ab');
  });

  it('makes the signature line from the full name, lets it be corrected, and asks for a new signature after a new director', async () => {
    const { s, reply } = server(SUPERADMIN, { ...EMPTY, director: DIRECTOR, seal: { stamp: null, signature: { ...PICTURE, director: DIRECTOR.fullName }, signers: [] } });
    s.set('PUT /app/api/admin/org-director', (call) => reply({ ...EMPTY, director: call.body as typeof DIRECTOR, signatureOutdated: true, seal: { stamp: null, signature: { ...PICTURE, director: DIRECTOR.fullName }, signers: [] } }));
    renderApp('/admin/org-profile');
    const user = userEvent.setup();
    const fullName = await screen.findByLabelText('ФИО руководителя');
    await user.clear(fullName);
    await user.type(fullName, 'Римский-Корсаков Николай Андреевич');
    expect(screen.getByLabelText('Как подписывать')).toHaveValue('Н. А. Римский-Корсаков');
    await user.click(within(screen.getByRole('region', { name: 'Руководитель' })).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/org-director')?.body).toEqual({ position: 'Генеральный директор', fullName: 'Римский-Корсаков Николай Андреевич', signatureName: 'Н. А. Римский-Корсаков' }));
    expect(await screen.findByText(/Загрузите подпись нового руководителя/)).toBeInTheDocument();
    // Whoever changed the director hears that the stamp stops until a new signature comes.
    expect(within(screen.getByRole('region', { name: 'Руководитель' })).getByText(/печать и подпись через агентов не ставятся/)).toBeInTheDocument();
  });

  it('tells an admin who is not a superadmin that the signature in the profile is of the former director', async () => {
    server(PROFILER, { ...EMPTY, director: DIRECTOR, signatureOutdated: true, seal: null });
    renderApp('/admin/org-profile');
    expect(await screen.findByText(/печать и подпись через агентов не ставятся/)).toBeInTheDocument();
  });

  it('names the responsible people from the list of employees', async () => {
    const { s, reply } = server(SUPERADMIN, EMPTY);
    s.set('PUT /app/api/admin/org-signers', () => reply({ ...EMPTY, seal: { stamp: null, signature: null, signers: [{ userId: 'olga', name: 'Ольга Смирнова', email: 'olga@example.com' }] } }));
    renderApp('/admin/org-profile');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Ольга Смирнова' }));
    await user.click(within(screen.getByRole('region', { name: 'Ответственные лица — печать и подпись' })).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/admin/org-signers')?.body).toEqual({ userIds: ['olga'] }));
    expect(await screen.findByText('Назначено: 1 сотрудник')).toBeInTheDocument();
  });
});
