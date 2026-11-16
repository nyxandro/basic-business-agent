import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { ensureMessageTexts } from './message-texts.ts';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const visible = async (content: string) => (await t.db.query<{ text: string }>('SELECT app.message_visible_text($1) AS text', [content])).rows[0]!.text;
const known = async (...words: string[]) => (await t.db.query<{ word: string }>('SELECT word FROM app.search_words WHERE word = ANY($1) ORDER BY word', [words])).rows.map((r) => r.word);
const kept = async (id: string) => (await t.db.query<{ text: string; role: string }>('SELECT text, role FROM app.message_texts WHERE message_id = $1', [id])).rows[0];
async function save(content: string, role = 'user'): Promise<string> {
  const id = randomUUID();
  await t.db.query(`INSERT INTO mastra.mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId") VALUES ($1, $2, $3, $4, 'v2', now(), 'someone')`, [id, randomUUID(), content, role]);
  return id;
}
const message = (...texts: string[]) => JSON.stringify({ format: 2, parts: [...texts.map((text) => ({ type: 'text', text })), { type: 'tool-invocation', toolInvocation: { state: 'result', toolName: 'crm_deals', result: { rows: ['Секретный клиент'] } } }] });

describe('the text people saw in messages, kept for the search (spec, section 8.21)', () => {
  it('is the text parts of a message as written, without tool calls and service words', async () => {
    expect(await visible(message('Проверь ДОГОВОР', 'Ёлка, счёт №12'))).toBe('Проверь ДОГОВОР\nЁлка, счёт №12');
  });

  it('is empty, never an error, for whatever is not the expected message', async () => {
    for (const content of ['не JSON', '{не JSON', '{"parts": 5}', '{"parts": [5, "x", null]}', '{"parts": [{"type": "text"}]}', '{"parts": [{"type": "text", "text": null}]}', '[]', '']) {
      expect(await visible(content)).toBe('');
    }
  });

  it('follows every message of a person or an agent as it is saved, changed and removed; a message in any form is saved', async () => {
    const id = await save(message('Договор поставки'));
    expect(await kept(id)).toEqual({ text: 'Договор поставки', role: 'user' });
    // Its words go into the dictionary a typo of a query is corrected by; «Секретный» of the tool result does not.
    expect(await known('договор', 'поставки', 'секретный')).toEqual(['договор', 'поставки']);
    await t.db.query('UPDATE mastra.mastra_messages SET content = $2 WHERE id = $1', [id, message('Договор аренды')]);
    expect((await kept(id))?.text).toBe('Договор аренды');
    await t.db.query('DELETE FROM mastra.mastra_messages WHERE id = $1', [id]);
    expect(await kept(id)).toBeUndefined();
    expect(await kept(await save('{не JSON'))).toEqual({ text: '', role: 'user' });
    expect(await kept(await save(message('Служебное'), 'system'))).toBeUndefined();
  });

  it('fills in at the start what was saved while the trigger was not there, and drops what is gone', async () => {
    await t.db.query('ALTER TABLE mastra.mastra_messages DISABLE TRIGGER bba_message_texts');
    const missed = await save(message('Смета по арматуре'), 'assistant');
    await t.db.query(`INSERT INTO app.message_texts (message_id, thread_id, role, text) VALUES ('gone', 'gone', 'user', 'нет такого')`);
    await t.db.query('ALTER TABLE mastra.mastra_messages ENABLE TRIGGER bba_message_texts');
    await ensureMessageTexts(t.db);
    expect(await kept(missed)).toEqual({ text: 'Смета по арматуре', role: 'assistant' });
    expect(await known('смета', 'арматуре')).toEqual(['арматуре', 'смета']);
    expect(await kept('gone')).toBeUndefined();
  });

  it('finds by a piece and by a typo through the index, not by reading every row', async () => {
    const client = await t.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = async (where: string) => (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT message_id FROM app.message_texts mt WHERE ${where}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
      const text = `replace(lower(coalesce(mt.text, '')), 'ё', 'е')`;
      expect(await plan(`${text} ILIKE '%договор%'`)).toContain('message_texts_search');
      expect(await plan(`'дговор' <% ${text}`)).toContain('message_texts_search');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
