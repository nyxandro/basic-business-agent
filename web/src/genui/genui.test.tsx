import { cardBlockSchema, chartBlockSchema, modelTableBlockSchema, type ChoiceBlock, type FormBlock } from '@bba/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CardBlockView } from './CardBlock.tsx';
import { CatalogBlock, type CallProps } from './CatalogBlock.tsx';
import { ChartBlockView } from './ChartBlock.tsx';
import { ChoiceBlockView } from './ChoiceBlock.tsx';
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
    expect(screen.getByRole('img', { name: 'Выручка' }).querySelectorAll('rect')).toHaveLength(4);
    expect(screen.getByText('Факт')).toBeInTheDocument();
    unmount();
    const line = render(<ChartBlockView block={{ ...CHART, kind: 'line' } as never} />);
    expect(line.container.querySelectorAll('polyline')).toHaveLength(2);
    line.unmount();
    render(<ChartBlockView block={{ kind: 'pie', labels: ['Юрлица', 'ИП'], series: [{ name: 'Доля', values: [3, 1] }] }} />);
    expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByText('Юрлица')).toBeInTheDocument();
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
    const { rerender } = render(<ChoiceBlockView block={CHOICE} answered={false} onAnswer={onAnswer} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Бета' }));
    expect(onAnswer).toHaveBeenCalledWith('Бета');
    rerender(<ChoiceBlockView block={CHOICE} answered onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: 'Альфа' })).toBeDisabled();
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
});
