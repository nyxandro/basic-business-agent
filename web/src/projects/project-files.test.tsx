// «Файлы проекта» (spec, section 8.20): upload, removal into the trash with «Вернуть», the stacks of
// versions of one document (decision of the owner 18.11) and a removed file turning to sand and leaving
// the list at once (request of the owner 18.11).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, type Reply } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { server } from './test-server.ts';

describe('«Файлы проекта»', () => {
  // A removed file goes into the project's trash at once, «Вернуть» brings it back (spec, section 8.20).
  it('uploads a file, and removes one into the trash with «Вернуть» in the notice', async () => {
    const s = server({
      'POST /app/api/projects/p1/files': { status: 201, body: { path: 'смета.xlsx', bytes: 2048 } },
      'DELETE /app/api/projects/p1/file': { body: { ok: true, trashId: 'tr1' } },
      'POST /app/api/projects/p1/trash/restore': { body: { restored: ['смета.xlsx'] } },
    });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    s.set('GET /app/api/projects/p1/files', { body: { files: [{ path: 'смета.xlsx', bytes: 2048 }] } });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), new File(['x'], 'смета.xlsx'));
    expect(await screen.findByText('2 КБ')).toBeInTheDocument();

    s.set('GET /app/api/projects/p1/files', { body: { files: [] } });
    s.set('GET /app/api/projects/p1/trash', { body: { batches: [{ id: 'b1', via: 'page', deletedBy: 'Ольга', deletedAt: '2026-11-16T08:00:00Z', overlapped: false, items: [{ id: 'tr1', path: 'смета.xlsx', bytes: 2048, kind: 'deleted', expiresAt: '2026-12-16T08:00:00Z' }] }] } });
    await user.click(screen.getByRole('button', { name: 'Удалить смета.xlsx' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/Файлов пока нет/)).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'DELETE')?.path).toBe('/app/api/projects/p1/file');
    expect(await screen.findByRole('button', { name: 'Корзина · 1' })).toBeInTheDocument();
    expect(await screen.findByText(/Файл «смета.xlsx» в корзине/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Вернуть' }));
    await waitFor(() => expect(s.calls.find((c) => c.path === '/app/api/projects/p1/trash/restore')?.body).toEqual({ ids: ['tr1'] }));
  });

  // Versions of one document in any format are one stack (decision of the owner 18.11).
  it('gathers the versions of a document into a stack that opens into its files and does not close', async () => {
    const top = ['v2.pdf', 'v2.pptx', 'v3.pdf', 'v3.pptx', '.pdf', '.pptx'].map((end) => ({ path: `Топ нейросетей для бизнес-агентов${end.startsWith('.') ? '' : ' '}${end}`, bytes: 136192 }));
    server({ 'GET /app/api/projects/p1/files': { body: { files: [{ path: 'Акт.pdf', bytes: 2048 }, ...top] } } });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    const stack = await screen.findByRole('button', { name: /Топ нейросетей для бизнес-агентов/ });
    expect(stack).toHaveAttribute('aria-expanded', 'false');
    expect(stack).toHaveTextContent('6 файлов · 3 версии · 3 PDF · 3 PowerPoint');
    expect(screen.getByText('Акт.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Топ нейросетей для бизнес-агентов v2.pdf')).not.toBeInTheDocument();

    await user.click(stack);
    for (const f of top) expect(screen.getByText(f.path)).toBeInTheDocument();
    // The stack fades out of its place for a moment.
    await waitFor(() => expect(screen.queryByRole('button', { name: /6 файлов/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Топ нейросетей для бизнес-агентов v2.pdf' })).toHaveFocus();
  });

  // A removed file turns to sand and leaves the list at once, as everywhere (request of the owner 18.11).
  it('takes a removed file off the list at once and brings it back when the server refuses', async () => {
    let answer: (reply: Reply) => void = () => undefined;
    server({
      'GET /app/api/projects/p1/files': { body: { files: [{ path: 'смета.xlsx', bytes: 2048 }, { path: 'акт.pdf', bytes: 1024 }] } },
      'DELETE /app/api/projects/p1/file': () => new Promise<Reply>((resolve) => (answer = resolve)),
    });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Удалить смета.xlsx' }));
    await waitFor(() => expect(screen.queryByText('смета.xlsx')).not.toBeInTheDocument());
    expect(screen.getByText('акт.pdf')).toBeInTheDocument();
    answer(apiError('APP_NOT_FOUND', 'Файл не найден.', 404));
    expect(await screen.findByText(/Файл не найден/)).toBeInTheDocument();
    expect(screen.getByText('смета.xlsx')).toBeVisible();
  });

  it('keeps a file off the list while its removal is under way, whatever list comes meanwhile', async () => {
    let answerB: (reply: Reply) => void = () => undefined;
    const files = (...paths: string[]) => ({ body: { files: paths.map((path) => ({ path, bytes: 1024 })) } });
    const s = server({
      'GET /app/api/projects/p1/files': files('a.pdf', 'b.pdf', 'c.pdf'),
      'DELETE /app/api/projects/p1/file': (call) => (call.query.path === 'b.pdf' ? new Promise<Reply>((resolve) => (answerB = resolve)) : { body: { ok: true, trashId: null } }),
    });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Удалить b.pdf' }));
    // After the moment in which a second click is taken for a slip.
    await new Promise((resolve) => setTimeout(resolve, 450));
    s.set('GET /app/api/projects/p1/files', files('b.pdf', 'c.pdf'));
    await user.click(screen.getByRole('button', { name: 'Удалить a.pdf' }));
    await waitFor(() => expect(s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects/p1/files')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('a.pdf')).not.toBeInTheDocument());
    expect(screen.queryByText('b.pdf')).not.toBeInTheDocument();
    s.set('GET /app/api/projects/p1/files', files('c.pdf'));
    answerB({ body: { ok: true, trashId: null } });
    await waitFor(() => expect(s.calls.filter((c) => c.method === 'GET' && c.path === '/app/api/projects/p1/files')).toHaveLength(3));
    expect(screen.queryByText('b.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('c.pdf')).toBeInTheDocument();
  });

  // The row turns to sand at once and the next one slides under the pointer: a double click must not take it too.
  it('takes a second click on «Удалить» right after a removal for a slip', async () => {
    const s = server({
      'GET /app/api/projects/p1/files': { body: { files: [{ path: 'a.pdf', bytes: 1024 }, { path: 'b.pdf', bytes: 1024 }] } },
      'DELETE /app/api/projects/p1/file': { body: { ok: true, trashId: null } },
    });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Удалить a.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Удалить b.pdf' }));
    await waitFor(() => expect(s.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1));
    expect(s.calls.find((c) => c.method === 'DELETE')?.query).toEqual({ path: 'a.pdf' });
  });

  // An upload that joins a stack would vanish into it: the stack opens instead.
  it('opens the stack a new upload joins, so the file is seen', async () => {
    const versions = ['Смета v1.xlsx', 'Смета v2.xlsx'].map((path) => ({ path, bytes: 2048 }));
    const s = server({ 'GET /app/api/projects/p1/files': { body: { files: versions } }, 'POST /app/api/projects/p1/files': { status: 201, body: { path: 'Смета v3.xlsx', bytes: 2048 } } });
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: /Смета/ })).toHaveAttribute('aria-expanded', 'false');
    s.set('GET /app/api/projects/p1/files', { body: { files: [...versions, { path: 'Смета v3.xlsx', bytes: 2048 }] } });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), new File(['x'], 'Смета v3.xlsx'));
    expect(await screen.findByText('Смета v3.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Смета v1.xlsx')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /3 файла/ })).not.toBeInTheDocument();
  });

  it('refuses a file over the limit with its own code and no repeat', async () => {
    const s = server();
    renderApp('/projects/p1?tab=files');
    const user = userEvent.setup();
    await screen.findByText(/Файлов пока нет/);
    const big = new File(['x'], 'огромный.pdf');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByLabelText('Загрузить файл', { selector: 'input' }), big);
    expect(await screen.findByText(/APP_UPLOAD_TOO_LARGE|больше 20 МБ/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
