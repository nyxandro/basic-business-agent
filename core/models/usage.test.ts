// Our copy of the usage ledger (spec, section 8.1): the gateway's search of the internet reports itself too, and
// is not counted while it is free (spec, section 8.30; decision of the owner 19.11); the batch it comes in is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { ingestUsage } from './usage.ts';

let database: TestDatabase;
let db: Db;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
});
afterAll(async () => {
  await db.end();
  await database.drop();
});

const record = (id: string, extra: Record<string, unknown>) => ({
  litellm_call_id: id,
  status: 'success',
  startTime: 1795117616.6,
  model_group: 'test-paid',
  model_id: 'paid-1',
  prompt_tokens: 10,
  completion_tokens: 5,
  response_cost: 0.01,
  metadata: { user_api_key_user_id: 'u-1', user_api_key_team_id: 't-1', requester_custom_headers: { 'x-bba-agent-id': 'sales' } },
  ...extra,
});

describe('usage ledger', () => {
  it('takes a batch with a search of the internet in it and keeps only the model call', async () => {
    const inserted = await ingestUsage(db, [
      record('model-1', { call_type: 'acompletion' }),
      // As the gateway sends a search (step 0, V29): no model group of its own, no tokens, zero cost.
      record('search-1', { call_type: 'asearch', model_group: null, model_id: null, prompt_tokens: null, completion_tokens: null, response_cost: 0, model: 'searxng/search' }),
    ]);
    expect(inserted).toBe(1);
    const { rows } = await db.query<{ litellm_call_id: string }>('SELECT litellm_call_id FROM app.usage_events');
    expect(rows.map((r) => r.litellm_call_id)).toEqual(['model-1']);
  });
});
