import { byRecentWork, type ProjectDto } from '@bba/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moveProject, pinProject, PROJECTS_SHOWN, shownProjects } from './order.ts';

const project = (id: string, pinned = false, lastActiveAt = '2026-11-15T08:00:00.000Z'): ProjectDto => ({ id, name: id, instructions: '', threadCount: 0, lastActiveAt, pinned, createdAt: '2026-11-15T08:00:00Z', role: 'owner', owner: { id: 'u1', name: 'Ольга' }, shared: false, unseen: false, access: null, archivedAt: null });
const ids = (list: ProjectDto[] | null) => list?.map((p) => `${p.id}${p.pinned ? '*' : ''}`) ?? null;
const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T08:00:00.000Z`;

// A side panel's list as the server gives it: the pinned ones first, the rest by the latest work.
const panel = fc
  .tuple(fc.nat({ max: 10 }), fc.array(fc.integer({ min: 1, max: 28 }), { maxLength: 10 }))
  .filter(([pinned, rest]) => pinned + rest.length > 0)
  .map(([pinned, rest]) => [...Array.from({ length: pinned }, (_, i) => project(`a${i}`, true)), ...rest.map((d, i) => project(`b${i}`, false, day(d))).sort(byRecentWork)]);
const pinnedFirst = (list: ProjectDto[]) => list.every((p, i) => i === 0 || !p.pinned || list[i - 1]!.pinned);
const restByWork = (list: ProjectDto[]) => {
  const rest = list.filter((p) => !p.pinned);
  return rest.every((p, i) => i === 0 || byRecentWork(rest[i - 1]!, p) <= 0);
};
const without = (list: ProjectDto[], id: string) => list.filter((p) => p.id !== id).map((p) => p.id);

describe('order of the side panel', () => {
  it('drags only a pinned project, and only among the pinned ones', () => {
    const list = [project('a', true), project('b', true), project('c'), project('d')];
    expect(ids(moveProject(list, 'b', 'a'))).toEqual(['b*', 'a*', 'c', 'd']);
    expect(moveProject(list, 'd', 'c')).toBeNull();
    expect(moveProject(list, 'c', 'b')).toBeNull();
    expect(moveProject(list, 'a', 'a')).toBeNull();
  });

  it('pins after the pinned ones; an unpinned one goes among the rest by its latest work', () => {
    const list = [project('a', true, day(1)), project('b', false, day(9)), project('c', false, day(5)), project('d', false, day(2))];
    expect(ids(pinProject(list, 'c', true))).toEqual(['a*', 'c*', 'b', 'd']);
    expect(ids(pinProject(list, 'a', false))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(pinProject([project('a', true, day(6)), ...list.slice(1)], 'a', false))).toEqual(['b', 'a', 'c', 'd']);
    expect(pinProject(list, 'a', true)).toBeNull();
    expect(ids(pinProject([project('a')], 'a', true))).toEqual(['a*']);
  });

  it('shows every pinned project and fills the panel up to ten with the rest', () => {
    const rest = Array.from({ length: 12 }, (_, i) => project(`r${i}`));
    expect(ids(shownProjects([project('a', true), ...rest], null))).toEqual(['a*', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    const pinned = Array.from({ length: 11 }, (_, i) => project(`p${i}`, true));
    expect(ids(shownProjects([...pinned, ...rest], null))).toEqual(pinned.map((p) => `${p.id}*`));
    // The open project further down is shown after them: it can be pinned from its row.
    expect(ids(shownProjects([project('a', true), ...rest], 'r11'))).toEqual(['a*', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r11']);
    expect(ids(shownProjects([project('a', true), ...rest], 'r2'))).toHaveLength(PROJECTS_SHOWN);
  });

  it('a dragged pinned project lands on the place it was dropped on, the others keep their order', () => {
    const drag = panel.chain((list) => fc.tuple(fc.constant(list), fc.nat({ max: list.length - 1 }), fc.nat({ max: list.length - 1 })));
    fc.assert(
      fc.property(drag, ([list, from, to]) => {
        const moved = moveProject(list, list[from]!.id, list[to]!.id);
        if (from === to || !list[from]!.pinned || !list[to]!.pinned) {
          expect(moved).toBeNull();
          return;
        }
        expect(moved![to]).toEqual(list[from]);
        expect(without(moved!, list[from]!.id)).toEqual(without(list, list[from]!.id));
        expect(pinnedFirst(moved!)).toBe(true);
      }),
    );
  });

  it('a pinned project ends the pinned ones, an unpinned one takes its place by work, the others keep their order', () => {
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
        if (pinned) expect(result!.findIndex((p) => p.id === id)).toBe(border - 1);
        expect(result!.find((p) => p.id === id)).toEqual({ ...list[at], pinned });
        expect(without(result!, id)).toEqual(without(list, id));
        expect(pinnedFirst(result!)).toBe(true);
        expect(restByWork(result!)).toBe(true);
      }),
    );
  });

  it('the panel shows the head of the list: every pinned one, ten rows unless more are pinned, and the open one after them', () => {
    const shown = panel.chain((list) => fc.tuple(fc.constant(list), fc.nat({ max: list.length - 1 })));
    fc.assert(
      fc.property(shown, ([list, open]) => {
        const rows = shownProjects(list, null);
        expect(rows).toEqual(list.slice(0, rows.length));
        expect(list.filter((p) => p.pinned).every((p) => rows.includes(p))).toBe(true);
        // Something is hidden under «Ещё» only behind ten rows; more than ten are all pinned.
        if (rows.length < list.length) expect(rows.length).toBeGreaterThanOrEqual(PROJECTS_SHOWN);
        if (rows.length > PROJECTS_SHOWN) expect(rows.every((p) => p.pinned)).toBe(true);
        const current = list[open]!;
        expect(shownProjects(list, current.id)).toEqual(rows.includes(current) ? rows : [...rows, current]);
      }),
    );
  });
});
