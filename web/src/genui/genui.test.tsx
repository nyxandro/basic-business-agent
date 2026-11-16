import { cardBlockSchema, chartBlockSchema, modelTableBlockSchema, withAttachments, type ChoiceBlock, type FormBlock } from '@bba/contracts';
import type { Message } from '@copilotkit/react-core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CardBlockView } from './CardBlock.tsx';
import { CatalogBlock, type CallProps } from './CatalogBlock.tsx';
import { ChartBlockView, pieSlices } from './ChartBlock.tsx';
import { answerOf } from './answer.ts';
import { ChoiceBlockView } from './ChoiceBlock.tsx';
import { FileCall } from './FileBlock.tsx';
import { FormBlockView } from './FormBlock.tsx';
import { TableBlockView } from './TableBlock.tsx';

const call = (parameters: unknown, extra: Partial<CallProps> = {}): CallProps => ({ toolCallId: 'c1', status: 'complete', parameters, result: '{"shown":true}', ...extra });

const TABLE = { title: 'Сделки', columns: [{ key: 'deal', label: 'Сделка' }, { key: 'sum', label: 'Сумма' }], rows: [{ deal: 'Поставка бетона', sum: 120000 }, { deal: 'Аренда', sum: null }] };
const CHART = { title: 'Выручка', kind: 'bar', labels: ['Сен', 'Окт'], series: [{ name: 'План', values: [10, 20] }, { name: 'Факт', values: [12, 18] }] };
const CARD = { title: 'Поставка бетона', subtitle: 'ООО «Пример»', fields: [{ label: 'Сумма', value: '120 000 ₽' }] };

describe('catalog blocks', () => {
  it('draws a table with numbers in Russian format', () => {
    render(<CatalogBlock call={call(TABLE)} schema={modelTableBlockSchema} View={TableBlockView} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Сумма' })).toBeInTheDocument();
    // Russian number format separates thousands with a non-breaking space.
    expect(screen.getByRole('cell', { name: '120\u00a0000' })).toBeInTheDocument();
    expect(screen.getByText('Сделки')).toBeInTheDocument();
  });

  it('draws bar, line and pie charts with a legend', () => {
    const { unmount } = render(<CatalogBlock call={call(CHART)} schema={chartBlockSchema} View={ChartBlockView} />);
    // Bars are paths: rounded at the data end, square on the axis.
    expect(screen.getByRole('img', { name: 'Выручка' }).querySelectorAll('path')).toHaveLength(4);
    expect(screen.getByText('Факт')).toBeInTheDocument();
    unmount();
    const line = render(<ChartBlockView block={{ ...CHART, kind: 'line' } as never} />);
    expect(line.container.querySelectorAll('polyline')).toHaveLength(2);
    line.unmount();
    render(<ChartBlockView block={{ kind: 'pie', labels: ['Юрлица', 'ИП'], series: [{ name: 'Доля', values: [3, 1] }] }} />);
    expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByText('Юрлица')).toBeInTheDocument();
  });

  it('folds the smallest slices of a pie into «Другое» past six colours', () => {
    const labels = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];
    const slices = pieSlices({ kind: 'pie', labels, series: [{ name: 'Доля', values: [8, 7, 6, 5, 4, 3, 2, 1] }] });
    expect(slices.map((s) => [s.label, s.value])).toEqual([['А', 8], ['Б', 7], ['В', 6], ['Г', 5], ['Д', 4], ['Другое', 6]]);
    expect(new Set(slices.map((s) => s.color)).size).toBe(6);
  });

  it('draws a card with its fields', () => {
    render(<CatalogBlock call={call(CARD)} schema={cardBlockSchema} View={CardBlockView} />);
    expect(screen.getByRole('heading', { name: 'Поставка бетона' })).toBeInTheDocument();
    expect(screen.getByText('120 000 ₽')).toBeInTheDocument();
  });

  it('shows «Не удалось показать данные» with the data as text when it does not fit', () => {
    const broken = { kind: 'bar', labels: ['Сен', 'Окт'], series: [{ name: 'План', values: [10] }] };
    render(<CatalogBlock call={call(broken)} schema={chartBlockSchema} View={ChartBlockView} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось показать данные');
    expect(screen.getByRole('alert')).toHaveTextContent('"План"');
  });

  it('shows the data as text when the server refused it, and a placeholder while it is written', () => {
    const { unmount } = render(<CatalogBlock call={call(TABLE, { result: '{"error":true,"message":"Tool input validation failed"}' })} schema={modelTableBlockSchema} View={TableBlockView} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось показать данные');
    unmount();
    render(<CatalogBlock call={call({}, { status: 'inProgress', result: undefined })} schema={modelTableBlockSchema} View={TableBlockView} />);
    expect(screen.getByText('Готовлю…')).toBeInTheDocument();
  });
});

describe('choice and form', () => {
  const CHOICE: ChoiceBlock = { question: 'Кому написать?', options: [{ value: 'a', label: 'Альфа' }, { value: 'b', label: 'Бета' }] };
  const FORM: FormBlock = {
    title: 'Заявка',
    fields: [
      { name: 'client', label: 'Клиент', kind: 'text', required: true },
      { name: 'sum', label: 'Сумма', kind: 'number', required: false },
      { name: 'stage', label: 'Этап', kind: 'select', required: true, options: ['Новая', 'Переговоры'] },
    ],
    submitLabel: 'Отправить заявку',
  };

  it('answers a choice with the label and is inactive once answered', async () => {
    const onAnswer = vi.fn();
    const { rerender } = render(<ChoiceBlockView block={CHOICE} answer={null} onAnswer={onAnswer} />);
    expect(screen.queryByText(', выбрано')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Бета' }));
    expect(onAnswer).toHaveBeenCalledWith('Бета');
    rerender(<ChoiceBlockView block={CHOICE} answer="Бета" onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: 'Альфа' })).toBeDisabled();
  });

  // Owner's list 16.11: the option the person took is set apart by colour and a tick.
  it('marks the option that was chosen, and none when the person answered in their own words', () => {
    const { rerender } = render(<ChoiceBlockView block={CHOICE} answer="Бета" onAnswer={() => undefined} />);
    const chosen = screen.getByRole('button', { name: 'Бета, выбрано' });
    expect(chosen).toHaveAttribute('data-chosen', 'true');
    expect(screen.getByRole('button', { name: 'Альфа' })).not.toHaveAttribute('data-chosen');
    rerender(<ChoiceBlockView block={CHOICE} answer="Лучше напишу Гамме" onAnswer={() => undefined} />);
    expect(screen.queryByText(', выбрано')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Бета' })).toBeDisabled();
  });

  it('finds the answer to a choice: the first message of the person after it, without the files block', () => {
    const call: Message = { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ask_choice', arguments: '{}' } }] };
    const before: Message = { id: 'u0', role: 'user', content: 'Кому написать письмо?' };
    expect(answerOf([before, call], 'c1')).toBeNull();
    expect(answerOf([before, call, { id: 't1', role: 'tool', toolCallId: 'c1', content: '{}' }], 'c1')).toBeNull();
    const reply: Message = { id: 'u1', role: 'user', content: [{ type: 'text', text: withAttachments(' Бета ', [{ name: 'смета.xlsx', path: 'files/смета.xlsx' }]) }] };
    expect(answerOf([before, call, reply, { id: 'u2', role: 'user', content: 'Альфа' }], 'c1')).toBe('Бета');
    expect(answerOf([before, call, reply], 'other')).toBeNull();
  });

  it('keeps errors next to the fields and sends the answers as one message', async () => {
    const onAnswer = vi.fn();
    render(<FormBlockView block={FORM} answered={false} onAnswer={onAnswer} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(screen.getAllByText('Заполните это поле.')).toHaveLength(2);
    expect(screen.getByLabelText('Клиент')).toHaveAttribute('aria-invalid', 'true');
    expect(onAnswer).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Клиент'), 'ООО Пример');
    await user.type(screen.getByLabelText('Сумма'), 'много');
    await user.selectOptions(screen.getByLabelText('Этап'), 'Переговоры');
    await user.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(screen.getByText('Нужно число.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Сумма'));
    await user.type(screen.getByLabelText('Сумма'), '1500');
    await user.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    expect(onAnswer).toHaveBeenCalledWith('Заявка:\n- Клиент: ООО Пример\n- Сумма: 1500\n- Этап: Переговоры');
  });

  // Spec, section 8.18: a file the agent made, with «Скачать» from the folder of the conversation.
  it('draws the file the agent made with its size and a link to download it from the conversation', () => {
    const result = JSON.stringify({ shown: true, path: 'итоги/КП «Ёлка».docx', name: 'КП «Ёлка».docx', bytes: 48_128 });
    render(<FileCall call={call({ path: 'итоги/КП «Ёлка».docx' }, { result })} threadId="t-1" />);
    expect(screen.getByText('КП «Ёлка».docx')).toBeInTheDocument();
    expect(screen.getByText('47 КБ')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Скачать КП «Ёлка».docx' });
    expect(link).toHaveAttribute('href', `/app/api/threads/t-1/file?path=${encodeURIComponent('итоги/КП «Ёлка».docx')}`);
    expect(link).toHaveAttribute('download', 'КП «Ёлка».docx');
  });

  it('draws nothing for a file that was not there, and a placeholder while the call runs', () => {
    const missing = render(<FileCall call={call({ path: 'нет.docx' }, { result: JSON.stringify({ shown: false, error: 'Файла «нет.docx» нет в рабочей папке.' }) })} threadId="t-1" />);
    expect(missing.container).toBeEmptyDOMElement();
    missing.unmount();
    render(<FileCall call={call({ path: 'КП.docx' }, { status: 'executing', result: undefined })} threadId="t-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Готовлю…');
  });
});
