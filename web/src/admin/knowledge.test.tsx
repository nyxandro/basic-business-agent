// «База знаний» (docs/specs/[20.11.2026]-knowledge-base.md, section 7): the person with «Документы организации» sees the
// organisation's base — documents with their reading state — and uploads files there.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const KEEPER = { ...ME, permissions: ['documents.org.manage'] };
const DOCS = [
  { id: 'd1', title: 'Регламент возвратов', kind: 'document', editionDate: '2026-03-12', currentVersion: 1, latestVersion: 1, status: 'ready', warning: null, errorCode: null, chunks: 4, fileName: 'Регламент возвратов.docx', size: 2048, updatedAt: '2026-11-22T06:00:00Z' },
  { id: 'd2', title: 'Скан договора', kind: 'document', editionDate: null, currentVersion: null, latestVersion: 1, status: 'rejected', warning: null, errorCode: 'APP_KNOWLEDGE_NO_TEXT', chunks: null, fileName: 'Скан.pdf', size: 4096, updatedAt: '2026-11-22T06:00:00Z' },
];

describe('«База знаний»', () => {
  it('shows the documents of the organisation with their state and uploads new ones', async () => {
    const s = mockServer({
      'GET /app/api/me': { body: KEEPER },
      'GET /app/api/knowledge/bases': { body: { org: true, departments: [] } },
      'GET /app/api/knowledge/documents': { body: { documents: DOCS } },
      'POST /app/api/knowledge/documents': { status: 201, body: { id: 'd3' } },
    });
    renderApp('/admin/knowledge');
    const list = await screen.findByRole('list', { name: 'Документы базы знаний' });
    expect(within(list).getByText('Регламент возвратов')).toBeInTheDocument();
    expect(within(list).getByText('Готов · 4 фрагм.')).toBeInTheDocument();
    expect(within(list).getByText(/Скан — текст не найден/)).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.setup().upload(input, new File(['# Прайс'], 'Прайс.md', { type: 'text/markdown' }));
    expect(await screen.findByText('Документы загружены')).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'POST' && c.path === '/app/api/knowledge/documents')).toBe(true);
  });
});
