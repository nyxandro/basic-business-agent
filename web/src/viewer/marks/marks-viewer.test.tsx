// The marks of the document viewer (spec, section 8.32): only from the chat, drawn → the window of the comment → a row
// of the list; kept in the browser until sent; «Отправить агенту» — one picture, one message, the draft gone, the
// viewer closed. PDF.js does not draw in jsdom: its pages are a stand-in with two pages and a stand-in document.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockServer } from '../../test/fetch-mock.ts';
import type { ViewerSource } from '../DocumentViewer.tsx';
import { useDocumentViewer } from '../use-viewer.tsx';
import { draftKey } from './draft.ts';
import type { Mark, MarksChannel, MarksDocument } from './types.ts';

const stand = vi.hoisted(() => ({ document: null as MarksDocument | null }));

vi.mock('../PdfPages.tsx', async () => {
  const { useMarks } = await import('./use-marks.ts');
  const { MarksLayer } = await import('./MarksLayer.tsx');
  function StandInPages({ onReady, onScale }: { onReady: () => void; onScale: (scale: number) => void }) {
    const attach = useMarks()?.attach;
    useEffect(() => {
      onScale(1);
      onReady();
    }, [onReady, onScale]);
    useEffect(() => {
      if (!attach || !stand.document) return;
      attach(stand.document);
      return () => attach(null);
    }, [attach]);
    return (
      <div data-testid="pdf-pages">
        <MarksLayer
          pages={[
            { page: 1, left: 0, top: 0, width: 600, height: 800 },
            { page: 2, left: 0, top: 820, width: 600, height: 800 },
          ]}
          scroller={() => null}
        />
      </div>
    );
  }
  return { default: StandInPages };
});

const TARGET = { threadId: 't1', path: 'Договор.docx', version: '120-1' };
const DOCX: ViewerSource = { name: 'Договор.docx', downloadUrl: '/app/api/threads/t1/file?path=d', previewUrl: '/app/api/threads/t1/file/preview?path=d', marks: TARGET };
const SAVED = { name: 'Договор.docx (пометки).jpg', path: '.marks/Договор.docx (пометки).jpg', bytes: 4 };

function Page({ source, channel }: { source: ViewerSource; channel: MarksChannel | null }) {
  const { open, viewer } = useDocumentViewer(channel);
  const location = useLocation();
  return (
    <>
      <button type="button" onClick={() => open(source)}>
        открыть
      </button>
      <output aria-label="адрес">{location.pathname + location.search}</output>
      {viewer}
    </>
  );
}

function show(source: ViewerSource, channel: MarksChannel | null) {
  // A page before the chat: a step «Назад» too many would land there.
  const view = render(
    <MemoryRouter initialEntries={['/agents/sales', '/agents/sales?thread=t1']} initialIndex={1}>
      <Page source={source} channel={channel} />
    </MemoryRouter>,
  );
  return { user: userEvent.setup(), view };
}

async function openViewer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'открыть' }));
  const viewer = screen.getByRole('dialog', { name: 'Договор.docx' });
  await within(viewer).findByTestId('pdf-pages');
  return viewer;
}

// The pictures of the pages lie where the stand-in puts them; everything else has no size in jsdom.
function placePages() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const page = this.getAttribute('data-page');
    const top = page ? (Number(page) - 1) * 820 : 0;
    const [width, height] = page ? [600, 800] : [0, 0];
    return { x: 0, y: top, left: 0, top, width, height, right: width, bottom: top + height, toJSON: () => ({}) };
  });
}

function draw(viewer: HTMLElement, page: number, from: [number, number], to: [number, number]) {
  const surface = viewer.querySelector(`svg[data-page="${page}"]`)!;
  const top = (page - 1) * 820;
  fireEvent.pointerDown(surface, { pointerId: 1, button: 0, pointerType: 'mouse', clientX: from[0], clientY: top + from[1] });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'mouse', clientX: to[0], clientY: top + to[1] });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse', clientX: to[0], clientY: top + to[1] });
}

beforeEach(() => {
  stand.document = { quote: vi.fn((mark: Mark) => Promise.resolve(mark.page === 1 ? 'Оплата в течение 30 дней' : '')), picture: vi.fn(() => Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))), reveal: vi.fn() };
  placePages();
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the marks of the viewer', () => {
  it('are offered only in the viewer opened from the chat, and not on text', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const fromProject = show({ ...DOCX, marks: undefined }, null);
    let viewer = await openViewer(fromProject.user);
    expect(within(viewer).queryByRole('button', { name: 'Пометки' })).not.toBeInTheDocument();
    fromProject.view.unmount();

    const text = show({ ...DOCX, name: 'заметки.txt' }, { send: vi.fn(() => true), running: false });
    mockServer({ 'GET /app/api/threads/t1/file': { raw: 'текст' } });
    await text.user.click(screen.getByRole('button', { name: 'открыть' }));
    viewer = screen.getByRole('dialog', { name: 'заметки.txt' });
    await within(viewer).findByText('текст');
    expect(within(viewer).queryByRole('button', { name: 'Пометки' })).not.toBeInTheDocument();
  });

  it('a frame drawn opens its window and lets the tool go; the comment becomes a row of the list and is kept in the browser', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Пометки' }));
    expect(within(viewer).getByRole('toolbar', { name: 'Инструменты пометок' })).toBeInTheDocument();
    // No list while there are no marks.
    expect(within(viewer).queryByRole('region', { name: /^Пометки · / })).not.toBeInTheDocument();
    await user.click(within(viewer).getByRole('button', { name: 'Прямоугольник' }));
    expect(within(viewer).getByRole('button', { name: 'Прямоугольник' })).toHaveAttribute('aria-pressed', 'true');
    // A press is not a mark, and the tool stays.
    draw(viewer, 1, [60, 80], [62, 82]);
    expect(within(viewer).queryByRole('dialog', { name: 'Пометка 1' })).not.toBeInTheDocument();
    expect(within(viewer).getByRole('button', { name: 'Прямоугольник' })).toHaveAttribute('aria-pressed', 'true');
    draw(viewer, 1, [60, 80], [300, 200]);
    // One figure a choice of the tool (owner, 20.11).
    expect(within(viewer).getByRole('button', { name: 'Прямоугольник' })).toHaveAttribute('aria-pressed', 'false');
    const window1 = within(viewer).getByRole('dialog', { name: 'Пометка 1' });
    // Not in the list and not kept until it has a comment and «Готово» is pressed (owner, 20.11).
    expect(within(window1).queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument();
    expect(within(viewer).queryByRole('region', { name: /^Пометки · / })).not.toBeInTheDocument();
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBeNull();
    await user.type(within(window1).getByRole('textbox', { name: 'Комментарий к пометке' }), '   ');
    expect(within(window1).queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument();
    await user.type(within(window1).getByRole('textbox', { name: 'Комментарий к пометке' }), 'срок оплаты 10 дней');
    await user.click(within(window1).getByRole('button', { name: 'Готово' }));
    expect(within(viewer).getByRole('region', { name: 'Пометки · 1' })).toBeInTheDocument();
    expect(within(viewer).queryByRole('dialog', { name: 'Пометка 1' })).not.toBeInTheDocument();
    const row = within(viewer).getByRole('button', { name: 'Пометка 1' });
    expect(row).toHaveTextContent('1стр. 1срок оплаты 10 дней');
    const stored = JSON.parse(localStorage.getItem(draftKey('t1', 'Договор.docx'))!) as { version: string; marks: { page: number; tool: string; points: unknown; comment: string }[] };
    expect(stored).toMatchObject({ version: '120-1', marks: [{ page: 1, tool: 'rect', comment: 'срок оплаты 10 дней', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.25 }] }] });
  });

  it('a row opens its mark to change the comment or remove it', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 2, tool: 'arrow', points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 }], comment: 'запятая' }] }));
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    // Unsent marks open the viewer with «Пометки» on.
    await user.click(within(viewer).getByRole('button', { name: 'Пометка 1' }));
    expect(stand.document!.reveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    const field = within(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).getByRole('textbox');
    expect(field).toHaveValue('запятая');
    await user.clear(field);
    // An emptied comment cannot be saved.
    expect(within(viewer).queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument();
    await user.type(field, 'лишняя запятая');
    // Changed only by «Готово».
    expect(within(viewer).getByRole('button', { name: 'Пометка 1' })).toHaveTextContent('запятая');
    expect(within(viewer).getByRole('button', { name: 'Пометка 1' })).not.toHaveTextContent('лишняя');
    await user.click(within(viewer).getByRole('button', { name: 'Готово' }));
    expect(within(viewer).getByRole('button', { name: 'Пометка 1' })).toHaveTextContent('лишняя запятая');
    // Esc leaves the comment as it was.
    await user.click(within(viewer).getByRole('button', { name: 'Пометка 1' }));
    await user.type(within(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).getByRole('textbox'), ' и пробел');
    await user.keyboard('{Escape}');
    expect(within(viewer).getByRole('button', { name: 'Пометка 1' })).toHaveTextContent(/лишняя запятая$/);
    await user.click(within(viewer).getByRole('button', { name: 'Пометка 1' }));
    await user.click(within(viewer).getByRole('button', { name: 'Удалить' }));
    expect(within(viewer).queryByRole('button', { name: 'Пометка 1' })).not.toBeInTheDocument();
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBeNull();
  });

  it('the cross of a row removes its mark from the list and the page; the window of another mark stays open', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    localStorage.setItem(
      draftKey('t1', 'Договор.docx'),
      JSON.stringify({
        version: '120-1',
        marks: [
          { id: 'm1', page: 1, tool: 'rect', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }], comment: 'срок' },
          { id: 'm2', page: 2, tool: 'ellipse', points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }], comment: 'шапка' },
        ],
      }),
    );
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Пометка 1' }));
    await user.click(within(viewer).getByRole('button', { name: 'Удалить пометку 2' }));
    expect(within(viewer).queryByRole('button', { name: 'Пометка 2' })).not.toBeInTheDocument();
    expect(viewer.querySelectorAll('[data-mark-id]')).toHaveLength(1);
    expect(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(draftKey('t1', 'Договор.docx'))!)).toMatchObject({ marks: [{ id: 'm1' }] });
  });

  it('marks of another version of the file are removed, and the person is told', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), JSON.stringify({ version: 'старая', marks: [{ id: 'm1', page: 1, tool: 'pen', points: [{ x: 0.1, y: 0.1 }], comment: '' }] }));
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    // «Пометки» open by themselves: the marks did not vanish without a word.
    expect(within(viewer).getByText('Документ изменился — прежние пометки к нему убраны')).toBeInTheDocument();
    expect(within(viewer).getByText('Пометки · 0')).toBeInTheDocument();
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBeNull();
  });

  it('«Отправить агенту» sends one picture and one message, forgets the marks and closes the viewer', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' }, 'POST /app/api/threads/t1/marks': { status: 201, body: SAVED } });
    localStorage.setItem(
      draftKey('t1', 'Договор.docx'),
      JSON.stringify({
        version: '120-1',
        marks: [
          { id: 'm1', page: 1, tool: 'rect', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }], comment: 'срок 10 дней' },
          { id: 'm2', page: 2, tool: 'pen', points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], comment: '' },
        ],
      }),
    );
    const send = vi.fn(() => true);
    const { user } = show(DOCX, { send, running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Отправить агенту' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Договор.docx' })).not.toBeInTheDocument());
    expect(stand.document!.picture).toHaveBeenCalledTimes(1);
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/marks')).toEqual([expect.objectContaining({ method: 'POST', form: { file: 'Договор.docx (пометки).jpg' } })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      [
        'Пометки к документу «Договор.docx» — 2:',
        '1. Стр. 1, прямоугольник: срок 10 дней',
        '   Под пометкой: «Оплата в течение 30 дней»',
        '2. Стр. 2, карандаш — без комментария',
        '',
        'Вложения:',
        '- Договор.docx (файл в рабочей папке: Договор.docx)',
        '- Договор.docx (пометки).jpg (файл в рабочей папке: .marks/Договор.docx (пометки).jpg)',
      ].join('\n'),
    );
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBeNull();
  });

  it('nothing is sent while the agent answers; a failure is said with its code and the marks stay', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' }, 'POST /app/api/threads/t1/marks': apiError('APP_MARKS_PICTURE_INVALID', 'Сервер не принял картинку с пометками.', 400) });
    const draft = JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 1, tool: 'ellipse', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }], comment: 'шапка' }] });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), draft);
    const busy = show(DOCX, { send: vi.fn(() => true), running: true });
    let viewer = await openViewer(busy.user);
    expect(within(viewer).getByRole('button', { name: 'Отправить агенту' })).toBeDisabled();
    expect(within(viewer).getByText('Агент отвечает — отправить можно после ответа')).toBeInTheDocument();
    busy.view.unmount();

    const send = vi.fn(() => true);
    const free = show(DOCX, { send, running: false });
    viewer = await openViewer(free.user);
    await free.user.click(within(viewer).getByRole('button', { name: 'Отправить агенту' }));
    const alert = await within(viewer).findByRole('alert');
    expect(alert).toHaveTextContent('Сервер не принял картинку с пометками.');
    expect(alert).toHaveTextContent('APP_MARKS_PICTURE_INVALID');
    expect(send).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBe(draft);
  });

  it('a picture that could not be made is said so', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    stand.document!.picture = vi.fn(() => Promise.reject(new Error('canvas.toBlob gave nothing')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(draftKey('t1', 'Договор.docx'), JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 1, tool: 'pen', points: [{ x: 0.1, y: 0.1 }], comment: '' }] }));
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Отправить агенту' }));
    expect(await within(viewer).findByRole('alert')).toHaveTextContent('Не получилось подготовить пометки к отправке. Попробуйте ещё раз. APP_MARKS_PREPARE_FAILED');
  });

  it('closing the viewer while the marks go sends nothing, keeps the marks and stays in the chat', async () => {
    let answer: (reply: { status: number; body: unknown }) => void = () => {};
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' }, 'POST /app/api/threads/t1/marks': () => new Promise((resolve) => (answer = resolve)) });
    const draft = JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 1, tool: 'rect', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }], comment: 'срок' }] });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), draft);
    const send = vi.fn(() => true);
    const { user } = show(DOCX, { send, running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Отправить агенту' }));
    expect(await within(viewer).findByRole('button', { name: 'Отправляю…' })).toBeDisabled();
    // While the picture goes, nothing new is drawn or changed: it would not be in the message.
    for (const name of ['Прямоугольник', 'Овал', 'Карандаш', 'Стрелка', 'Пометка 1']) expect(within(viewer).getByRole('button', { name })).toBeDisabled();
    await user.click(within(viewer).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog', { name: 'Договор.docx' })).not.toBeInTheDocument();
    answer({ status: 201, body: SAVED });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBe(draft);
    expect(screen.getByRole('status', { name: 'адрес' })).toHaveTextContent('/agents/sales?thread=t1');
  });

  it('when the agent began to answer while the picture went, the marks stay and the person is told', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' }, 'POST /app/api/threads/t1/marks': { status: 201, body: SAVED } });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 1, tool: 'pen', points: [{ x: 0.1, y: 0.1 }], comment: '' }] }));
    const send = vi.fn(() => false);
    const { user } = show(DOCX, { send, running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Отправить агенту' }));
    expect(await within(viewer).findByRole('alert')).toHaveTextContent('Агент отвечает — отправить можно после ответа');
    expect(within(viewer).getByRole('button', { name: 'Пометка 1' })).toBeInTheDocument();
  });

  it('Esc lets a chosen tool go, closes the window of a mark, and only then the viewer', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Пометки' }));
    await user.click(within(viewer).getByRole('button', { name: 'Стрелка' }));
    await user.keyboard('{Escape}');
    expect(within(viewer).getByRole('button', { name: 'Стрелка' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(viewer).getByRole('button', { name: 'Стрелка' }));
    draw(viewer, 2, [100, 100], [300, 300]);
    expect(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(viewer).queryByRole('dialog', { name: 'Пометка 1' })).not.toBeInTheDocument();
    // Not saved — gone with its window.
    expect(viewer.querySelectorAll('[data-mark-id]')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Договор.docx' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Договор.docx' })).not.toBeInTheDocument();
  });

  it('a mark left without «Готово» is gone when the next one is drawn', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Пометки' }));
    await user.click(within(viewer).getByRole('button', { name: 'Овал' }));
    draw(viewer, 1, [60, 80], [300, 200]);
    await user.type(within(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).getByRole('textbox'), 'не сохраню');
    await user.click(within(viewer).getByRole('button', { name: 'Прямоугольник' }));
    expect(viewer.querySelectorAll('[data-mark-id]')).toHaveLength(0);
    draw(viewer, 1, [100, 300], [400, 400]);
    expect(viewer.querySelectorAll('[data-mark-id]')).toHaveLength(1);
    expect(within(within(viewer).getByRole('dialog', { name: 'Пометка 1' })).getByRole('textbox')).toHaveValue('');
    expect(localStorage.getItem(draftKey('t1', 'Договор.docx'))).toBeNull();
  });

  it('the list goes when its last mark is removed', async () => {
    mockServer({ 'GET /app/api/threads/t1/file/preview': { raw: '%PDF' } });
    localStorage.setItem(draftKey('t1', 'Договор.docx'), JSON.stringify({ version: '120-1', marks: [{ id: 'm1', page: 1, tool: 'pen', points: [{ x: 0.1, y: 0.1 }], comment: '' }] }));
    const { user } = show(DOCX, { send: vi.fn(() => true), running: false });
    const viewer = await openViewer(user);
    await user.click(within(viewer).getByRole('button', { name: 'Удалить пометку 1' }));
    await waitFor(() => expect(within(viewer).queryByRole('region', { name: /^Пометки · / })).not.toBeInTheDocument());
    expect(within(viewer).getByRole('toolbar', { name: 'Инструменты пометок' })).toBeInTheDocument();
  });
});
