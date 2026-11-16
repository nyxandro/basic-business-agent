import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { MESSAGE_TEXT_INDEX } from './text-index.ts';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const textOf = async (content: string) => (await t.db.query<{ text: string }>('SELECT app.message_search_text($1) AS text', [content])).rows[0]!.text;
const message = (content: string, role = 'user') =>
  t.db.query(`INSERT INTO mastra.mastra_messages (id, thread_id, content, role, type, "createdAt") VALUES ($1, $2, $3, $4, 'v2', now())`, [randomUUID(), randomUUID(), content, role]);

describe('the visible text of messages for the search (spec, section 8.21)', () => {
  it('is the text parts of a message in lower case, «ё» as «е», without tool calls and service words', async () => {
    const stored = JSON.stringify({
      format: 2,
      parts: [
        { type: 'text', text: 'Проверь ДОГОВОР' },
        { type: 'tool-invocation', toolInvocation: { state: 'result', toolName: 'crm_deals', result: { rows: ['Секретный клиент'] } } },
        { type: 'text', text: 'Ёлка, счёт №12' },
      ],
    });
    expect(await textOf(stored)).toBe('проверь договор\nелка, счет №12');
  });

  it('is empty, never an error, for whatever is not the expected message', async () => {
    for (const content of ['не JSON', '{не JSON', '{"parts": 5}', '{"parts": [5, "x", null]}', '{"parts": [{"type": "text"}]}', '{"parts": [{"type": "text", "text": null}]}', '[]', '']) {
      expect(await textOf(content)).toBe('');
    }
  });

  it('is indexed on Mastra’s messages, and a message in any form is still saved', async () => {
    const { rows } = await t.db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'mastra' AND indexname = $1`, [MESSAGE_TEXT_INDEX]);
    expect(rows[0]?.indexdef).toContain('app.message_search_text(content) gin_trgm_ops');
    for (const content of ['не JSON', '{не JSON', '{"parts": 5}', '{"parts": [{"type": "text", "text": "Договор"}]}']) await message(content);
    await message('{"parts": [{"type": "text", "text": "Ответ агента"}]}', 'assistant');
  });

  it('finds by a piece and by a typo through the index, not by reading every message', async () => {
    const client = await t.db.connect();
    try {
      await client.query('BEGIN');
      // A few rows make reading the table cheaper than the index: the plan must still be able to use it.
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = async (where: string) => (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT id FROM mastra.mastra_messages WHERE role IN ('user', 'assistant') AND ${where}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(await plan(`app.message_search_text(content) ILIKE '%договор%'`)).toContain(MESSAGE_TEXT_INDEX);
      expect(await plan(`'дговор' <% app.message_search_text(content)`)).toContain(MESSAGE_TEXT_INDEX);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
