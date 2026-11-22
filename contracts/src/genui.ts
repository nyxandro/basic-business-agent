import { z } from 'zod';

// Catalog of the interactive answer blocks (spec, section 17.8). The model fills these through
// A2UI for small answers; big tables are drawn straight from tool results, not retyped by the model.
export const MAX_TABLE_ROWS = 500;
export const MAX_MODEL_TABLE_ROWS = 20;
export const CHART_SERIES_MAX = 6;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const tableBlockSchema = z.object({
  title: z.string().optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1).max(20),
  rows: z.array(z.record(z.string(), cell)).max(MAX_TABLE_ROWS),
});

export const chartBlockSchema = z
  .object({
    title: z.string().optional(),
    kind: z.enum(['bar', 'line', 'pie']),
    labels: z.array(z.string()).min(1).max(100),
    // Six series: the interface has six colours told apart in both themes (web tokens --series-*).
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1).max(CHART_SERIES_MAX),
  })
  .refine((c) => c.series.every((s) => s.values.length === c.labels.length), { message: 'every series needs one value per label', path: ['series'] });

export const cardBlockSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).max(20),
});

export const choiceBlockSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).min(2).max(6),
});

export const formBlockSchema = z.object({
  title: z.string(),
  fields: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        kind: z.enum(['text', 'number', 'date', 'select']),
        required: z.boolean(),
        options: z.array(z.string()).optional(),
      }),
    )
    .min(2)
    .max(8)
    .refine((fields) => fields.every((f) => f.kind !== 'select' || (f.options?.length ?? 0) >= 2), { message: 'a select field needs at least two options' }),
  submitLabel: z.string(),
});

export type TableBlock = z.infer<typeof tableBlockSchema>;
export type ChartBlock = z.infer<typeof chartBlockSchema>;
export type CardBlock = z.infer<typeof cardBlockSchema>;
export type ChoiceBlock = z.infer<typeof choiceBlockSchema>;
export type FormBlock = z.infer<typeof formBlockSchema>;

// What the model may assemble itself: small tables only. Big ones come straight from tool results.
export const modelTableBlockSchema = tableBlockSchema.extend({
  rows: z.array(z.record(z.string(), cell)).max(MAX_MODEL_TABLE_ROWS),
});

// Tools of the core that draw the catalog in the chat (core/genui, web/src/genui).
export const GENUI_TOOL = {
  table: 'show_table',
  chart: 'show_chart',
  card: 'show_card',
  choice: 'ask_choice',
  form: 'ask_form',
  // A file the agent made in the folder of the conversation, with «Скачать» (spec, section 8.18).
  file: 'show_file',
} as const;
export const GENUI_TOOL_IDS: readonly string[] = Object.values(GENUI_TOOL);

// What show_file answers: the file is there (path from the folder of the conversation), or why not.
export const fileBlockResultSchema = z.discriminatedUnion('shown', [
  // `made` — the agent made or changed the file in this answer (not an attachment of the person): «Хороший образец» is
  // offered on it (docs/specs/[20.11.2026]-feedback-and-value.md). Absent in answers before 22.11.
  z.object({ shown: z.literal(true), path: z.string(), name: z.string(), bytes: z.number(), made: z.boolean().optional() }),
  z.object({ shown: z.literal(false), error: z.string() }),
]);
export type FileBlockResult = z.infer<typeof fileBlockResultSchema>;

// A plugin tool whose result has this shape gets its table drawn in the chat as is.
export const toolTableResultSchema = z.object({ table: tableBlockSchema });
