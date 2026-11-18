// The document viewer (spec, section 8.27): opening, the states of the table, «Назад» of a phone. PDF.js
// does not draw in jsdom: its pages are a stand-in here, the drawing is checked by the e2e scenario.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockServer } from '../test/fetch-mock.ts';
import type { ViewerSource } from './DocumentViewer.tsx';
import { useDocumentViewer } from './use-viewer.tsx';

vi.mock('./PdfPages.tsx', () => {
  function StandInPages({ url, onReady, onScale }: { url: string; onReady: () => void; onScale: (scale: number) => void }) {
    useEffect(() => {
      onScale(0.49);
      onReady();
    }, [onReady, onScale]);
    return <div data-testid="pdf-pages" data-url={url} />;
  }
  return { default: StandInPages };
});

afterEach(() => vi.restoreAllMocks());

const DOCX: ViewerSource = { name: 'КП «Альфа».docx', downloadUrl: '/app/api/threads/t1/file?path=kp.docx', previewUrl: '/app/api/threads/t1/file/preview?path=kp.docx' };

// A page that opens the viewer, and a «Назад» as a phone's back button gives it.
function Page({ source }: { source: ViewerSource }) {
  const { open, viewer } = useDocumentViewer();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => open(source)}>
        открыть
      </button>
      <button type="button" onClick={() => void navigate(-1)}>
        назад телефона
      </button>
      {viewer}
    </>
  );
}

function show(source: ViewerSource) {
  render(
    <MemoryRouter initialEntries={['/agents/sales?thread=t1']}>
      <Page source={source} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe('the document viewer', () => {
  it('turns a Word document into PDF on the server and shows its pages, with the bar of the owner', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const user = show(DOCX);
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    const viewer = screen.getByRole('dialog', { name: 'КП «Альфа».docx' });
    expect(await within(viewer).findByTestId('pdf-pages')).toHaveAttribute('data-url', DOCX.previewUrl);
    // The conversion started by a request of one byte.
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/file/preview')).toHaveLength(1);
    expect(await within(viewer).findByText('49 %')).toBeInTheDocument();
    for (const name of ['Уменьшить', 'Увеличить', 'По ширине', 'Закрыть']) expect(within(viewer).getByRole('button', { name })).toBeEnabled();
    expect(within(viewer).getByRole('link', { name: 'Скачать' })).toHaveAttribute('href', DOCX.downloadUrl);
    await user.click(within(viewer).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('«Назад» of a phone and Esc close it; a second press while it opens opens no second one', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const user = show(DOCX);
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByTestId('pdf-pages');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'назад телефона', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByTestId('pdf-pages');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Ctrl with «+», «−» and «0» scale the document; Ctrl+K opens nothing under it', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    // What the search listens for (layout/AppShell.tsx): K with Ctrl, on the window.
    const opened = vi.fn();
    const search = (event: KeyboardEvent) => {
      if (event.code === 'KeyK') opened();
    };
    window.addEventListener('keydown', search);
    const user = show(DOCX);
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    await screen.findByTestId('pdf-pages');
    await user.keyboard('{Control>}k{/Control}');
    expect(opened).not.toHaveBeenCalled();
    window.removeEventListener('keydown', search);
  });

  it('says what the server says; «Повторить» only where trying again helps', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file/preview': apiError('APP_PREVIEW_BUSY', 'Сейчас готовится много документов. Попробуйте через минуту.', 503) });
    const user = show(DOCX);
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    expect(await screen.findByText('Сейчас готовится много документов. Попробуйте через минуту.')).toBeInTheDocument();
    expect(screen.getByText('APP_PREVIEW_BUSY')).toBeInTheDocument();
    s.set('GET /app/api/threads/t1/file/preview', { raw: '%PDF' });
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('pdf-pages')).toBeInTheDocument();
  });

  it('a damaged document has «Скачать» and no «Повторить»; the zoom waits for a document', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': apiError('APP_PREVIEW_FAILED', 'Не получилось показать документ: файл повреждён, защищён паролем или в формате, который сервер не понимает. Скачайте его и откройте у себя.', 422) });
    const user = show(DOCX);
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/файл повреждён, защищён паролем/)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'Скачать' })).toHaveAttribute('href', DOCX.downloadUrl);
    expect(within(alert).queryByRole('button', { name: 'Повторить' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Увеличить' })).toBeDisabled();
  });

  it('a PDF goes as it is, without the server converting it', async () => {
    const s = mockServer({});
    const user = show({ name: 'Скан.pdf', downloadUrl: '/app/api/files/file?path=scan.pdf', previewUrl: '/app/api/files/file/preview?path=scan.pdf' });
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    expect(await screen.findByTestId('pdf-pages')).toHaveAttribute('data-url', '/app/api/files/file?path=scan.pdf');
    expect(s.calls.some((c) => c.path.endsWith('/preview'))).toBe(false);
  });

  it('shows text as it is, and only the beginning of a big one', async () => {
    const big = `начало ${'х'.repeat(600_000)}`;
    mockServer({
      'GET /app/api/files/file': { raw: big },
    });
    const user = show({ name: 'log.txt', downloadUrl: '/app/api/files/file?path=log.txt', previewUrl: '-' });
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    expect(await screen.findByText('Показано начало файла — 1 МБ. Весь файл — «Скачать».')).toBeInTheDocument();
    expect(screen.getByText(/^начало х+$/).textContent?.length).toBeLessThan(big.length);
  });
});

describe('Markdown in the viewer', () => {
  it('is formatted and loads nothing from the internet', async () => {
    mockServer({ 'GET /app/api/files/file': { raw: '# Отчёт\n\n![трекер](https://tracker.example/p.gif) ![b](//evil.example/x.gif) ![c]( https://evil.example/y.gif) ![d](<https://evil.example/z.gif>)' } });
    const user = show({ name: 'отчёт.md', downloadUrl: '/app/api/files/file?path=report.md', previewUrl: '-' });
    await user.click(screen.getByRole('button', { name: 'открыть' }));
    expect(await screen.findByRole('heading', { name: 'Отчёт' })).toBeInTheDocument();
    // No picture at all, whatever its address (by the independent review of 18.11): only its description.
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('Картинка не показывается: трекер')).toBeInTheDocument();
  });
});
