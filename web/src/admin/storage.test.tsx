// «Хранилище файлов» (spec, section 8.23): a superadmin connects an S3 bucket in a few clicks — the preset
// of a service fills its address and region, the form asks for the bucket and the keys; the state, the
// moving of files and the failures of the bucket are seen; disconnecting asks first.
import type { StorageStatus } from '@bba/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const SUPER = { ...ME, isSuperadmin: true, permissions: ['storage'] };
const LOCAL: StorageStatus = { mode: 'local', state: 'active', bucket: null, stored: { files: 0, bytes: 0 }, local: { folders: 3, waiting: 0 }, lastError: null };
const CONNECTED: StorageStatus = {
  mode: 's3',
  state: 'active',
  bucket: { provider: 'yandex', endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1', bucket: 'alfa-files', prefix: '', pathStyle: true, connectedAt: '2026-11-17T02:00:00.000Z' },
  stored: { files: 21, bytes: 3 * 1024 * 1024 },
  local: { folders: 1, waiting: 0 },
  lastError: null,
};

describe('«Хранилище файлов»', () => {
  it('connects Yandex Object Storage with the bucket and the keys; the address and region come from the preset', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: SUPER },
      'GET /app/api/admin/storage': { body: LOCAL },
      'POST /app/api/admin/storage': { body: { ...CONNECTED, state: 'to_s3', local: { folders: 3, waiting: 3 } } },
    });
    renderApp('/admin/storage');
    const user = userEvent.setup();
    expect(await screen.findByText('Файлы хранятся на диске сервера')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yandex Object Storage' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('Бакет'), 'alfa-files');
    await user.type(screen.getByLabelText('Ключ доступа (Access Key ID)'), 'YCAJE');
    await user.type(screen.getByLabelText('Секретный ключ (Secret Access Key)'), 'YCsecret');
    await user.click(screen.getByRole('button', { name: 'Проверить и подключить' }));
    expect(await screen.findByText('Переносим файлы в хранилище · осталось папок: 3')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({
      provider: 'yandex',
      endpoint: 'https://storage.yandexcloud.net',
      region: 'ru-central1',
      pathStyle: true,
      bucket: 'alfa-files',
      prefix: '',
      accessKeyId: 'YCAJE',
      secretAccessKey: 'YCsecret',
    });
  });

  it('another service opens the address and the region to fill; a refusal of the bucket is shown with what to check', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: SUPER },
      'GET /app/api/admin/storage': { body: LOCAL },
      'POST /app/api/admin/storage': { status: 502, body: { error: { code: 'APP_STORAGE_ACCESS_DENIED', message: 'Хранилище файлов отказало в доступе: ключ неверный, отозван или у него нет прав на этот бакет.', nextStep: 'Проверьте ключ доступа и его права в консоли провайдера и введите его заново в «Хранилище файлов».' } } },
    });
    renderApp('/admin/storage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Другой S3-совместимый' }));
    expect(screen.getByLabelText('Адрес сервиса')).toHaveValue('');
    await user.type(screen.getByLabelText('Адрес сервиса'), 'https://minio.example.com');
    await user.type(screen.getByLabelText('Регион'), 'us-east-1');
    await user.type(screen.getByLabelText('Папка в бакете'), 'bba');
    await user.type(screen.getByLabelText('Бакет'), 'files');
    await user.type(screen.getByLabelText('Ключ доступа (Access Key ID)'), 'k');
    await user.type(screen.getByLabelText('Секретный ключ (Secret Access Key)'), 's');
    await user.click(screen.getByRole('button', { name: 'Проверить и подключить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('отказало в доступе');
    expect(screen.getByRole('alert')).toHaveTextContent('APP_STORAGE_ACCESS_DENIED');
    expect(s.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ provider: 'other', endpoint: 'https://minio.example.com', region: 'us-east-1', prefix: 'bba', pathStyle: true });
    // What was typed stays.
    expect(screen.getByLabelText('Бакет')).toHaveValue('files');
  });

  it('shows the bucket, what it holds and a failure; disconnecting asks and brings the files back', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: SUPER },
      'GET /app/api/admin/storage': { body: { ...CONNECTED, lastError: { code: 'APP_STORAGE_UNAVAILABLE', at: '2026-11-17T02:30:00.000Z' } } },
      'DELETE /app/api/admin/storage': { body: { ...CONNECTED, state: 'to_local', local: { folders: 1, waiting: 4 } } },
    });
    renderApp('/admin/storage');
    const user = userEvent.setup();
    expect(await screen.findByText('Файлы хранятся в Yandex Object Storage')).toBeInTheDocument();
    expect(screen.getByText('В хранилище: 21 файл · 3 МБ')).toBeInTheDocument();
    expect(screen.getByText('Работает')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('APP_STORAGE_UNAVAILABLE');
    await user.click(screen.getByRole('button', { name: 'Отключить хранилище' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Вернуть файлы на сервер?' });
    expect(ask).toHaveTextContent('3 МБ');
    await user.click(within(ask).getByRole('button', { name: 'Вернуть файлы на сервер' }));
    expect(await screen.findByText('Возвращаем файлы на сервер · осталось папок: 4')).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    // While files move nothing else is offered.
    expect(screen.queryByRole('button', { name: 'Сменить ключи' })).not.toBeInTheDocument();
  });

  it('changes the keys after checking them', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: SUPER },
      'GET /app/api/admin/storage': { body: CONNECTED },
      'PUT /app/api/admin/storage/keys': { body: CONNECTED },
    });
    renderApp('/admin/storage');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Сменить ключи' }));
    await user.type(screen.getByLabelText('Ключ доступа (Access Key ID)'), 'new-key');
    await user.type(screen.getByLabelText('Секретный ключ (Secret Access Key)'), 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ accessKeyId: 'new-key', secretAccessKey: 'new-secret' }));
    expect(await screen.findByText('Ключи сохранены')).toBeInTheDocument();
  });

  it('a person with the right but not a superadmin sees the state and cannot connect', async () => {
    mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['storage'] } }, 'GET /app/api/admin/storage': { body: LOCAL } });
    renderApp('/admin/storage');
    expect(await screen.findByText('Подключать, менять ключи и отключать хранилище может только суперадминистратор.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Проверить и подключить' })).toBeDisabled();
  });

  it('is not in the menu without its right', async () => {
    mockServer({ 'GET /app/api/me': { body: { ...ME, permissions: ['users'] } }, 'GET /app/api/admin/users': { body: { users: [] } } });
    renderApp('/admin/users');
    expect(await screen.findByRole('navigation', { name: 'Разделы админки' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Хранилище файлов' })).not.toBeInTheDocument();
  });
});
