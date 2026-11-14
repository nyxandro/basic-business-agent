// Catalog of interface blocks (spec, section 17.8) as tools of the core. The model fills a block
// through the tool arguments; Mastra checks them against the schema of contracts/src/genui.ts and
// returns broken data to the model with the fields to fix. The browser draws the call
// (web/src/genui). The blocks change nothing outside the chat, so they never ask for "Да".
import { cardBlockSchema, chartBlockSchema, choiceBlockSchema, formBlockSchema, GENUI_TOOL, MAX_MODEL_TABLE_ROWS, modelTableBlockSchema } from '@bba/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { AnyTool } from '../plugins/public/index.ts';

const shownSchema = z.object({ shown: z.literal(true), waitForAnswer: z.boolean().optional(), note: z.string().optional() });

const shown = () => Promise.resolve({ shown: true as const });
// The person answers a choice or a form with their next message: the turn ends here.
const waitForAnswer = () => Promise.resolve({ shown: true as const, waitForAnswer: true, note: 'Ответ сотрудника придёт следующим сообщением. Закончи ход и жди его.' });

export function createGenuiTools(): Record<string, AnyTool> {
  const tools = [
    createTool({
      id: GENUI_TOOL.table,
      description: `Показать в чате небольшую таблицу (до ${MAX_MODEL_TABLE_ROWS} строк), которую ты собрал сам. Таблицы, которые уже показал другой инструмент, не повторяй.`,
      inputSchema: modelTableBlockSchema,
      outputSchema: shownSchema,
      execute: shown,
    }),
    createTool({
      id: GENUI_TOOL.chart,
      description: 'Показать в чате график: столбцы (bar), линия (line) или круг (pie). В каждом ряду по одному значению на каждую подпись.',
      inputSchema: chartBlockSchema,
      outputSchema: shownSchema,
      execute: shown,
    }),
    createTool({
      id: GENUI_TOOL.card,
      description: 'Показать в чате карточку одного объекта: заголовок и поля «название — значение» (сделка, контакт, документ).',
      inputSchema: cardBlockSchema,
      outputSchema: shownSchema,
      execute: shown,
    }),
    createTool({
      id: GENUI_TOOL.choice,
      description: 'Попросить сотрудника выбрать один из 2–6 вариантов кнопкой. Выбор придёт его следующим сообщением.',
      inputSchema: choiceBlockSchema,
      outputSchema: shownSchema,
      execute: waitForAnswer,
    }),
    createTool({
      id: GENUI_TOOL.form,
      description: 'Попросить сотрудника заполнить короткую форму (2–8 полей). Ответы придут его следующим сообщением.',
      inputSchema: formBlockSchema,
      outputSchema: shownSchema,
      execute: waitForAnswer,
    }),
  ];
  return Object.fromEntries(tools.map((tool) => [tool.id, tool as AnyTool]));
}
