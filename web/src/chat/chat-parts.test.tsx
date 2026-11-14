import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard.tsx';
import { chatErrorOf } from './chat-errors.ts';
import { withAttachments } from './ChatViewSlot.tsx';
import { systemOf } from './systems.ts';
import { parseToolResult } from './tool-result.ts';
import { ToolRow, type ToolRowProps } from './ToolRow.tsx';

const SYSTEMS = { tools: { notes_add: 'Заметки' }, prefixes: { bitrix24_: 'Битрикс24' } };

describe('confirmation card', () => {
  const interrupt = { metadata: { mastra: { toolName: 'notes_add', args: { text: 'Позвонить в пятницу' } } } };

  it('shows what will happen and answers «Да» once', async () => {
    const onYes = vi.fn();
    const onNo = vi.fn();
    render(<ApprovalCard interrupt={interrupt} systems={SYSTEMS} onYes={onYes} onNo={onNo} />);
    expect(screen.getByText('Подтвердите действие')).toBeInTheDocument();
    expect(screen.getByText('Заметки: notes_add')).toBeInTheDocument();
    expect(screen.getByText('Позвонить в пятницу')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Да, выполнить' }));
    expect(onYes).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Выполняю…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Нет' })).toBeDisabled();
    expect(onNo).not.toHaveBeenCalled();
  });

  it('answers «Нет»', async () => {
    const onNo = vi.fn();
    render(<ApprovalCard interrupt={interrupt} systems={SYSTEMS} onYes={vi.fn()} onNo={onNo} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Нет' }));
    expect(onNo).toHaveBeenCalledTimes(1);
  });
});

describe('tool line', () => {
  const row = (p: Partial<ToolRowProps>) =>
    render(
      <MemoryRouter>
        <ToolRow name="bitrix24_deals" status="complete" systems={SYSTEMS} {...p} />
      </MemoryRouter>,
    );

  it('names the system while the call runs', () => {
    row({ status: 'executing' });
    expect(screen.getByText('Ищу в «Битрикс24»…')).toBeInTheDocument();
  });

  it('tells a declined action from one cancelled by a new message', () => {
    const { unmount } = row({ result: '{"declined":true,"superseded":false}' });
    expect(screen.getByText('Действие отменено')).toBeInTheDocument();
    unmount();
    row({ result: '{"declined":true,"superseded":true}' });
    expect(screen.getByText('Отменено: вы написали новое сообщение')).toBeInTheDocument();
  });

  it('links to the settings when the personal connection is missing', () => {
    row({ result: JSON.stringify({ error: true, message: 'APP_CONNECTOR_NOT_CONNECTED: подключите Битрикс24' }) });
    expect(screen.getByText(/Действие «Битрикс24» не выполнилось/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Подключить в настройках' })).toHaveAttribute('href', '/settings/connections');
  });

  it('draws a table that came in the result as is', () => {
    const table = { title: 'Сделки', columns: [{ key: 'n', label: 'Сделка' }], rows: [{ n: 'Поставка' }] };
    row({ result: JSON.stringify({ table }) });
    expect(screen.getByText('Готово: «Битрикс24»')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Поставка' })).toBeInTheDocument();
  });
});

describe('chat helpers', () => {
  it('reads tool results', () => {
    expect(parseToolResult('{"declined":true,"superseded":true}')).toEqual({ kind: 'declined', superseded: true });
    expect(parseToolResult('{"error":true,"message":"x APP_TOOL_FAILED"}')).toEqual({ kind: 'failed', code: 'APP_TOOL_FAILED', message: 'x APP_TOOL_FAILED' });
    expect(parseToolResult('{"deals":12}')).toEqual({ kind: 'ok', value: { deals: 12 } });
    expect(parseToolResult('просто текст')).toEqual({ kind: 'ok', value: 'просто текст' });
  });

  it('finds the system of a tool by exact name or prefix', () => {
    expect(systemOf(SYSTEMS, 'notes_add')).toBe('Заметки');
    expect(systemOf(SYSTEMS, 'bitrix24_connection')).toBe('Битрикс24');
    expect(systemOf(SYSTEMS, 'sales_report')).toBeNull();
  });

  it('names attached files in the message', () => {
    expect(withAttachments('Прочитай счёт', [])).toBe('Прочитай счёт');
    expect(withAttachments('Прочитай счёт', [{ name: 'Счёт.pdf', path: 'uploads/t1/Счёт.pdf', bytes: 10 }])).toBe(
      'Прочитай счёт\n\nВложения:\n- Счёт.pdf (файл в рабочей папке: uploads/t1/Счёт.pdf)',
    );
  });

  it('turns a refused turn into our code and text', () => {
    const http = chatErrorOf(new Error('HTTP 402: {"error":{"code":"APP_USAGE_LIMIT_EXCEEDED","message":"Ваш лимит исчерпан."}}'));
    expect([http.code, http.message]).toEqual(['APP_USAGE_LIMIT_EXCEEDED', 'Ваш лимит исчерпан.']);
    const stream = chatErrorOf(Object.assign(new Error('Модель сейчас не отвечает.'), { code: 'APP_MODEL_UNAVAILABLE' }));
    expect(stream.code).toBe('APP_MODEL_UNAVAILABLE');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(chatErrorOf(new Error('socket hang up')).code).toBe('APP_CHAT_STREAM_INTERRUPTED');
  });
});
