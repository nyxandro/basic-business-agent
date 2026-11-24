// A message of the marks of a document in the chat (spec, section 8.32; request of the owner 25.11): one block «Правки к
// документу «…» · 3 пометки» in the bubble; unfolded — the document, the picture of the marks and the lines of the marks.
// Any other message of the person stays as it was.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChatExtrasContext, type ChatExtras } from '../answer/chat-context.ts';
import { UserMessage } from './UserMessage.tsx';

const MARKS = [
  'Пометки к документу «Хакатон.docx» — 2:',
  '1. Стр. 1, прямоугольник: 123',
  '   Под пометкой: «Хакатон «ИИКузница»»',
  '2. Стр. 1, стрелка: убрать это тест',
  '',
  'Вложения:',
  '- Хакатон.docx (файл в рабочей папке: Хакатон.docx)',
  '- Хакатон.docx (пометки).jpg (файл в рабочей папке: .marks/Хакатон.docx (пометки).jpg)',
].join('\n');

const show = (content: string) =>
  render(
    <ChatExtrasContext value={{ threadId: 't1' } as ChatExtras}>
      <UserMessage content={content} />
    </ChatExtrasContext>,
  );

describe('the marks of a document in the chat', () => {
  it('is one folded block with the document and the count, unfolded — the files and the lines of the marks', async () => {
    show(MARKS);
    const toggle = screen.getByRole('button', { name: 'Правки к документу «Хакатон.docx» · 2 пометки' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Под пометкой/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Хакатон.docx (пометки).jpg')).not.toBeInTheDocument();
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('region', { name: 'Правки к документу «Хакатон.docx» · 2 пометки' });
    expect(within(details).getByTitle('Хакатон.docx')).toBeInTheDocument();
    expect(within(details).getByTitle('Хакатон.docx (пометки).jpg')).toBeInTheDocument();
    expect(within(details).getByText(/1\. Стр\. 1, прямоугольник: 123/)).toBeInTheDocument();
    expect(within(details).getByText(/2\. Стр\. 1, стрелка: убрать это тест/)).toBeInTheDocument();
  });

  it('leaves any other message as it was', () => {
    show('Вот файлы\n\nВложения:\n- Схема.png (файл в рабочей папке: Схема.png)');
    expect(screen.getByTitle('Схема.png')).toBeInTheDocument();
    expect(screen.getByText('Вот файлы')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Правки к/ })).not.toBeInTheDocument();
  });
});
