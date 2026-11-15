import type { ProjectDto } from '@bba/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moveProject, pinProject } from './order.ts';

const project = (id: string, pinned = false): ProjectDto => ({ id, name: id, instructions: '', threadCount: 0, pinned, createdAt: '2026-11-15T08:00:00Z', role: 'owner', owner: { id: 'u1', name: 'Ольга' }, shared: false, unseen: false, access: null, archivedAt: null });
const ids = (list: ProjectDto[] | null) => list?.map((p) => `${p.id}${p.pinned ? '*' : ''}`) ?? null;

// A side panel's list as the server gives it: the pinned projects first.
const panel = fc
  .tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 }))
  .filter(([pinned, rest]) => pinned + rest > 0)
  .map(([pinned, rest]) => Array.from({ length: pinned + rest }, (_, i) => project(`p${i}`, i < pinned)));
const pinnedFirst = (list: ProjectDto[]) => list.every((p, i) => i === 0 || !p.pinned || list[i - 1]!.pinned);
const without = (list: ProjectDto[], id: string) => list.filter((p) => p.id !== id).map((p) => p.id);

describe('order of the side panel', () => {
  it('drags a project only among its own group', () => {
    const list = [project('a', true), project('b', true), project('c'), project('d'), project('e')];
    expect(ids(moveProject(list, 'e', 'c'))).toEqual(['a*', 'b*', 'e', 'c', 'd']);
    expect(ids(moveProject(list, 'a', 'b'))).toEqual(['b*', 'a*', 'c', 'd', 'e']);
    expect(moveProject(list, 'c', 'b')).toBeNull();
    expect(moveProject(list, 'c', 'c')).toBeNull();
  });

  it('pins after the pinned ones and unpins first among the rest', () => {
    const list = [project('a', true), project('b'), project('c'), project('d')];
    expect(ids(pinProject(list, 'd', true))).toEqual(['a*', 'd*', 'b', 'c']);
    expect(ids(pinProject(pinProject(list, 'd', true)!, 'a', false))).toEqual(['d*', 'a', 'b', 'c']);
    expect(pinProject(list, 'a', true)).toBeNull();
    expect(ids(pinProject([project('a')], 'a', true))).toEqual(['a*']);
  });

  it('a dragged project lands on the place it was dropped on, the others keep their order', () => {
    const drag = panel.chain((list) => fc.tuple(fc.constant(list), fc.nat({ max: list.length - 1 }), fc.nat({ max: list.length - 1 })));
    fc.assert(
      fc.property(drag, ([list, from, to]) => {
        const moved = moveProject(list, list[from]!.id, list[to]!.id);
        if (from === to || list[from]!.pinned !== list[to]!.pinned) {
          expect(moved).toBeNull();
          return;
        }
        expect(moved!.map((p) => p.id).sort()).toEqual(list.map((p) => p.id).sort());
        expect(moved![to]).toEqual(list[from]);
        expect(without(moved!, list[from]!.id)).toEqual(without(list, list[from]!.id));
        expect(pinnedFirst(moved!)).toBe(true);
      }),
    );
  });

  it('a pinned project ends the pinned ones, an unpinned one starts the rest, the others keep their order', () => {
    const pin = panel.chain((list) => fc.tuple(fc.constant(list), fc.nat({ max: list.length - 1 }), fc.boolean()));
    fc.assert(
      fc.property(pin, ([list, at, pinned]) => {
        const id = list[at]!.id;
        const result = pinProject(list, id, pinned);
        if (list[at]!.pinned === pinned) {
          expect(result).toBeNull();
          return;
        }
        const border = result!.filter((p) => p.pinned).length;
        expect(result!.findIndex((p) => p.id === id)).toBe(pinned ? border - 1 : border);
        expect(result!.find((p) => p.id === id)).toEqual({ ...list[at], pinned });
        expect(without(result!, id)).toEqual(without(list, id));
        expect(result).toHaveLength(list.length);
        expect(pinnedFirst(result!)).toBe(true);
      }),
    );
  });
});
