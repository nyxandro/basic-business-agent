// Names of MCP actions for the model (docs/specs/[20.11.2026]-mcp-connections.md, section 8): providers take
// only `^[a-zA-Z0-9_-]{1,64}$`, and one bad name rejects the whole request of the agent.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { modelNames } from './tool-names.ts';

const SLUG = 'm1a2b3c';
const ALLOWED = /^[a-zA-Z0-9_-]{1,64}$/;

describe('names of actions for the model', () => {
  it('replaces what providers do not take: crm.deal.list → m1a2b3c_crm_deal_list', () => {
    expect(modelNames(SLUG, ['crm.deal.list']).get('crm.deal.list')).toBe('m1a2b3c_crm_deal_list');
    expect(modelNames(SLUG, ['deals_search']).get('deals_search')).toBe('m1a2b3c_deals_search');
  });

  it('cuts a long name to 64 and ends it with a fingerprint of the full name', () => {
    const long = `crm.${'x'.repeat(76)}`;
    const name = modelNames(SLUG, [long]).get(long)!;
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^m1a2b3c_crm_x+_[0-9a-f]{6}$/);
    expect(modelNames(SLUG, [`${long}y`]).get(`${long}y`)).not.toBe(name);
  });

  it('tells apart names that become one after the replacement', () => {
    const names = modelNames(SLUG, ['crm.deal.list', 'crm_deal_list']);
    expect(new Set(names.values()).size).toBe(2);
    for (const name of names.values()) expect(name).toMatch(/^m1a2b3c_crm_deal_list_[0-9a-f]{6}$/);
  });

  it('gives every set of server names allowed, distinct names, whatever the order', () => {
    // Few symbols so that names often collide after the replacement; any Unicode too, as servers send it.
    const name = fc.oneof(
      fc.string({ unit: fc.constantFrom('a', 'b', '.', '_', '-', 'я', '😀', ' '), minLength: 1, maxLength: 70 }),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 90 }),
      // Names near and over the limit: 64 less the slug and «_» leaves 56 for the server's name.
      fc.string({ unit: 'grapheme-ascii', minLength: 50, maxLength: 90, size: 'max' }),
    );
    const sets = fc.uniqueArray(name, { minLength: 1, maxLength: 30 }).chain((names) => fc.tuple(fc.constant(names), fc.shuffledSubarray(names, { minLength: names.length })));
    fc.assert(
      fc.property(sets, ([names, shuffled]) => {
        const result = modelNames(SLUG, names);
        expect([...result.keys()].sort()).toEqual([...names].sort());
        for (const value of result.values()) {
          expect(value).toMatch(ALLOWED);
          expect(value.startsWith(`${SLUG}_`)).toBe(true);
        }
        expect(new Set(result.values()).size).toBe(names.length);
        expect(modelNames(SLUG, shuffled)).toEqual(result);
      }),
      {
        examples: [
          [[['crm.deal.list', 'crm_deal_list', 'crm-deal-list'], ['crm-deal-list', 'crm.deal.list', 'crm_deal_list']]],
          [[['сделки', 'задачи'], ['задачи', 'сделки']]],
          [[[`crm.${'x'.repeat(76)}`], [`crm.${'x'.repeat(76)}`]]],
          [[[`a${'.'.repeat(80)}`, `a${'_'.repeat(80)}`], [`a${'_'.repeat(80)}`, `a${'.'.repeat(80)}`]]],
        ],
      },
    );
  });
});
