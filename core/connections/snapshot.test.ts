// The snapshot of a server's actions (docs/specs/[20.11.2026]-mcp-connections.md, section 4, step 3): what a new
// snapshot keeps of the admin's marks, what it marks new or changed, and what the admin may mark.
import type { SerializableMCPToolDefinition } from '@mastra/mcp';
import { describe, expect, it } from 'vitest';
import { isAppError } from '../errors/app-error.ts';
import { applyActionMarks, definitionForCalls, mergeSnapshot, toActionView } from './snapshot.ts';

const SLUG = 'm1a2b3c';

function definition(name: string, over: Partial<SerializableMCPToolDefinition> = {}): SerializableMCPToolDefinition {
  return { name, description: `Действие ${name}`, inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, server: { name: SLUG }, ...over };
}

function rejection(run: () => unknown): { code: string; userMessage: string } {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, userMessage: error.userMessage };
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('the first snapshot', () => {
  it('gives every action off, named for the model, and nothing «new»', () => {
    const actions = mergeSnapshot(SLUG, [], [definition('crm.deal.list'), definition('crm.deal.add')], true);
    expect(actions.map((a) => [a.name, a.modelName, a.enabled, a.isNew])).toEqual([
      ['crm.deal.list', 'm1a2b3c_crm_deal_list', false, false],
      ['crm.deal.add', 'm1a2b3c_crm_deal_add', false, false],
    ]);
  });
});

describe('a new snapshot over the previous one', () => {
  const previous = applyActionMarks(mergeSnapshot(SLUG, [], [definition('crm.deal.list'), definition('crm.deal.add'), definition('crm.old')], true), [
    { name: 'crm.deal.list', enabled: true, readOnly: true, title: 'Список сделок', check: true },
    { name: 'crm.deal.add', enabled: true, readOnly: false, title: null, check: false },
  ]);

  it('keeps the admin’s marks, turns off and marks what appeared, drops what is gone', () => {
    const next = mergeSnapshot(SLUG, previous, [definition('crm.deal.list'), definition('crm.deal.add'), definition('crm.task.add')], false);
    const byName = new Map(next.map((a) => [a.name, a]));
    expect(byName.get('crm.deal.list')).toMatchObject({ enabled: true, readOnly: true, title: 'Список сделок', check: true, isNew: false, isChanged: false });
    expect(byName.get('crm.task.add')).toMatchObject({ enabled: false, readOnly: false, isNew: true });
    expect(byName.has('crm.old')).toBe(false);
  });

  it('marks an action whose description or parameters changed, and only those', () => {
    const next = mergeSnapshot(SLUG, previous, [definition('crm.deal.list', { description: 'Список сделок с фильтром' }), definition('crm.deal.add', { inputSchema: { properties: { id: { type: 'string' } }, type: 'object' } })], false);
    expect(next.map((a) => [a.name, a.isChanged, a.enabled])).toEqual([
      ['crm.deal.list', true, true],
      ['crm.deal.add', false, true],
    ]);
  });
});

describe('the definition a call is built from', () => {
  it('keeps the server’s hints of a safe repeat only on an action the admin marked as reading', () => {
    const [writes] = mergeSnapshot(SLUG, [], [definition('crm.invoice.add', { annotations: { idempotentHint: true, readOnlyHint: true } })], true);
    expect(definitionForCalls(writes!).annotations).toMatchObject({ idempotentHint: false, readOnlyHint: false });
    const [reads] = applyActionMarks([writes!], [{ name: 'crm.invoice.add', enabled: true, readOnly: true, title: null, check: false }]);
    expect(definitionForCalls(reads!).annotations).toMatchObject({ idempotentHint: true, readOnlyHint: true });
  });
});

describe('the admin’s marks', () => {
  const actions = mergeSnapshot(SLUG, [], [definition('crm.deal.list', { annotations: { readOnlyHint: true } }), definition('crm.deal.add')], true);

  it('saving them is looking at the list: «new» and «changed» are cleared, an empty title is the server’s', () => {
    const marked = applyActionMarks(
      actions.map((a) => ({ ...a, isNew: true, isChanged: true })),
      [{ name: 'crm.deal.list', enabled: true, readOnly: true, title: '', check: false }],
    );
    expect(marked.map((a) => [a.name, a.enabled, a.title, a.isNew, a.isChanged])).toEqual([
      ['crm.deal.list', true, null, false, false],
      ['crm.deal.add', false, null, false, false],
    ]);
  });

  it('refuse an action the snapshot does not have, two check actions and a check action that writes', () => {
    const mark = (name: string, over = {}) => ({ name, enabled: true, readOnly: true, title: null, check: false, ...over });
    expect(rejection(() => applyActionMarks(actions, [mark('crm.gone')])).code).toBe('APP_VALIDATION_FAILED');
    expect(rejection(() => applyActionMarks(actions, [mark('crm.deal.list', { check: true }), mark('crm.deal.add', { check: true })])).code).toBe('APP_VALIDATION_FAILED');
    expect(rejection(() => applyActionMarks(actions, [mark('crm.deal.add', { check: true, readOnly: false })])).userMessage).toContain('только чтение');
  });

  it('show the admin the server’s hint and title, and what the action costs in tokens', () => {
    const [list, add] = actions.map(toActionView);
    expect(list).toMatchObject({ readOnlyHint: true, serverTitle: 'crm.deal.list', title: null });
    expect(add!.readOnlyHint).toBe(false);
    expect(list!.tokens).toBeGreaterThan(10);
    expect(toActionView(mergeSnapshot(SLUG, [], [definition('crm.deal.list', { title: 'Сделки' })], true)[0]!).serverTitle).toBe('Сделки');
  });
});
