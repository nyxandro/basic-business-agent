// A chip of a picture shows the picture over it while the mouse is on it (request of the owner 20.11): read only when
// first hovered, once; not for other files, not for a touch.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockServer } from '../test/fetch-mock.ts';
import { UserMessage } from './UserMessage.tsx';
import { ChatExtrasContext, type ChatExtras } from './chat-context.ts';

const extras = { threadId: 't1' } as ChatExtras;
const message = 'Вот файлы\n\nВложения:\n- Схема.png (файл в рабочей папке: Схема.png)\n- Договор.docx (файл в рабочей папке: Договор.docx)';

function show() {
  return render(
    <ChatExtrasContext value={extras}>
      <UserMessage content={message} />
    </ChatExtrasContext>,
  );
}

// The name of a chip is drawn in parts (FileName.tsx); its whole name is its title.
const chipOf = (name: string) => screen.getByTitle(name);

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:picture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the peek of a picture', () => {
  it('shows the picture over its chip after a moment of hovering, read once; hides when the mouse leaves', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file': { raw: 'png' } });
    show();
    const chip = chipOf('Схема.png');
    fireEvent.pointerOver(chip, { pointerType: 'mouse' });
    const picture = await screen.findByRole('img', { name: 'Схема.png' });
    expect(picture).toHaveAttribute('src', 'blob:picture');
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/file')).toEqual([expect.objectContaining({ query: { path: 'Схема.png' } })]);
    fireEvent.pointerOut(chip, { pointerType: 'mouse', relatedTarget: document.body });
    expect(screen.queryByRole('img', { name: 'Схема.png' })).not.toBeInTheDocument();
    fireEvent.pointerOver(chip, { pointerType: 'mouse' });
    await screen.findByRole('img', { name: 'Схема.png' });
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/file')).toHaveLength(1);
  });

  it('is not for other files, and not for a finger', async () => {
    const s = mockServer({ 'GET /app/api/threads/t1/file': { raw: 'png' } });
    show();
    fireEvent.pointerOver(chipOf('Договор.docx'), { pointerType: 'mouse' });
    fireEvent.pointerOver(chipOf('Схема.png'), { pointerType: 'touch' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === '/app/api/threads/t1/file')).toHaveLength(0);
  });

  it('says so when the picture cannot be read', async () => {
    mockServer({});
    show();
    fireEvent.pointerOver(chipOf('Схема.png'), { pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByText('Картинку не удалось показать')).toBeInTheDocument());
  });
});
