// The unsent marks of a file live in this browser until they are sent (spec, section 8.32; decision of the owner
// 20.11, F44): per person, conversation and file, with the version of the file they were drawn on.
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftKey, parseDraft, readStoredDraft, serializeDraft, storeDraft, type MarksDraft } from './draft.ts';
import { MARK_TOOLS, type Mark } from './types.ts';

// A share of the page as the layer makes it: from 0 to 1, never −0 (clampShare gives +0).
const share = fc.double({ min: 0, max: 1, noNaN: true }).map((v) => (Object.is(v, -0) ? 0 : v));
const point = fc.record({ x: share, y: share });
const mark: fc.Arbitrary<Mark> = fc
  .record({ id: fc.uuid(), page: fc.integer({ min: 1, max: 5000 }), tool: fc.constantFrom(...MARK_TOOLS), comment: fc.string({ unit: 'binary', maxLength: 300 }) })
  .chain((m) => (m.tool === 'pen' ? fc.array(point, { minLength: 1, maxLength: 40 }) : fc.tuple(point, point)).map((points) => ({ ...m, points })));
const draft: fc.Arbitrary<MarksDraft> = fc.record({ version: fc.string({ minLength: 1, maxLength: 40 }), marks: fc.array(mark, { maxLength: 12 }) });

describe('the draft of marks', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads back exactly what was written', () => {
    fc.assert(
      fc.property(draft, (d) => {
        expect(parseDraft(serializeDraft(d))).toEqual(d);
      }),
      {
        examples: [
          [{ version: '10-1', marks: [] }],
          [{ version: '10-1', marks: [{ id: 'a', page: 1, tool: 'pen', points: [{ x: 0, y: 1 }], comment: 'Строка 1\nстрока 2 🙂' }] }],
        ],
      },
    );
  });

  it('something else under its key is no draft', () => {
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft(JSON.stringify({ version: '1', marks: [{ id: 'a', page: 1, tool: 'rect', points: [{ x: 0, y: 0 }], comment: '' }] }))).toBeNull();
    expect(parseDraft(JSON.stringify({ version: '1', marks: [{ id: 'a', page: 0, tool: 'pen', points: [{ x: 2, y: 0 }], comment: '' }] }))).toBeNull();
  });

  it('is kept per person, conversation and file, and gone when emptied', () => {
    const key = draftKey('u1', 't1', 'Договор.docx');
    expect(key).not.toBe(draftKey('u2', 't1', 'Договор.docx'));
    expect(readStoredDraft(key)).toEqual({ state: 'none' });
    const d: MarksDraft = { version: '10-1', marks: [{ id: 'a', page: 2, tool: 'rect', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], comment: 'срок' }] };
    expect(storeDraft(key, d)).toBe(true);
    expect(readStoredDraft(key)).toEqual({ state: 'found', draft: d });
    expect(storeDraft(key, null)).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('says so when the browser keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const key = draftKey('u1', 't1', 'a.pdf');
    expect(readStoredDraft(key)).toEqual({ state: 'unavailable' });
    expect(storeDraft(key, { version: '1', marks: [{ id: 'a', page: 1, tool: 'pen', points: [{ x: 0.5, y: 0.5 }], comment: '' }] })).toBe(false);
  });
});
