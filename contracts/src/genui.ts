import { z } from 'zod';

// Catalog of the interactive answer blocks (spec, section 17.8). The model fills these through
// A2UI for small answers; big tables are drawn straight from tool results, not retyped by the model.
export const MAX_TABLE_ROWS = 500;
export const MAX_MODEL_TABLE_ROWS = 20;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const tableBlockSchema = z.object({
  title: z.string().optional(),
  columns: z.array(z.object({ key: z.string(), label: z.string() })).min(1).max(20),
  rows: z.array(z.record(z.string(), cell)).max(MAX_TABLE_ROWS),
});

export const chartBlockSchema = z.object({
  title: z.string().optional(),
  kind: z.enum(['bar', 'line', 'pie']),
  labels: z.array(z.string()).min(1).max(100),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1).max(8),
});

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
    .max(8),
  submitLabel: z.string(),
});

export type TableBlock = z.infer<typeof tableBlockSchema>;
export type ChartBlock = z.infer<typeof chartBlockSchema>;
export type CardBlock = z.infer<typeof cardBlockSchema>;
export type ChoiceBlock = z.infer<typeof choiceBlockSchema>;
export type FormBlock = z.infer<typeof formBlockSchema>;
