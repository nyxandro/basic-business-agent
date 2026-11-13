// Example plugin of the template: the employee's personal notes. Shows the whole plugin contract:
// settings, its own table (migrations/), a read-only tool and a tool that needs confirmation.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { definePlugin, pluginSchemaName, requireUserId } from '../../core/plugins/public/index.ts';

const SCHEMA = pluginSchemaName('example-notes');

export default definePlugin({
  name: 'example-notes',
  title: 'Заметки',
  settings: z.object({ maxNotes: z.number().int().positive() }),
  secrets: [],
  readOnly: ['notes_list'],
  tools: ({ db, settings }) => ({
    notes_list: createTool({
      id: 'notes_list',
      description: 'Показать заметки сотрудника, новые сверху.',
      inputSchema: z.object({}),
      outputSchema: z.object({ notes: z.array(z.object({ id: z.number(), text: z.string(), createdAt: z.string() })) }),
      execute: async (_input, context) => {
        const { rows } = await db.query<{ id: number; text: string; created_at: Date }>(
          `SELECT id::int AS id, text, created_at FROM ${SCHEMA}.notes WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
          [requireUserId(context), settings.maxNotes],
        );
        return { notes: rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at.toISOString() })) };
      },
    }),
    notes_add: createTool({
      id: 'notes_add',
      description: 'Добавить заметку сотруднику.',
      inputSchema: z.object({ text: z.string().min(1).max(2000) }),
      outputSchema: z.object({ id: z.number() }),
      execute: async ({ text }, context) => {
        const { rows } = await db.query<{ id: number }>(`INSERT INTO ${SCHEMA}.notes (user_id, text) VALUES ($1, $2) RETURNING id::int AS id`, [
          requireUserId(context),
          text,
        ]);
        return { id: rows[0]!.id };
      },
    }),
  }),
});
