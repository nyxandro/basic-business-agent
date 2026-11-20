// The model of the marks (spec, section 8.32): shares of the page that do not move with the scale, the text under
// a mark from the text of the page, the message to the agent.
import { splitAttachments } from '@bba/contracts';
import { describe, expect, it } from 'vitest';
import { badgeAt, boundsOf, clampShare, isMarkTooSmall, markPath } from './geometry.ts';
import { marksMessage } from './message.ts';
import { textBoxes, textUnder, type TextBox } from './text-under.ts';

// A page 600 × 800 points, not turned: PDF's y goes up from the bottom, the page's shares go down from the top.
const viewport = { width: 600, height: 800, convertToViewportPoint: (x: number, y: number) => [x, 800 - y] };
const item = (str: string, x: number, baseline: number, width: number, height = 12) => ({ str, transform: [height, 0, 0, height, x, baseline], width, height, dir: 'ltr', fontName: 'f', hasEOL: false });
// Lines of a page: «Оплата производится в течение 30 дней» at the top, a second line under it.
const page: TextBox[] = textBoxes(
  [
    item('Оплата производится', 60, 700, 120),
    item('в течение 30 дней', 186, 700, 108),
    item('Покупатель, обязуется оплатить', 60, 680, 186),
    item('', 60, 660, 0),
  ],
  viewport,
);
const ASPECT = 800 / 600;

describe('the place of a mark', () => {
  it('is kept as shares of the page, inside it', () => {
    expect(clampShare(-0.2)).toBe(0);
    expect(clampShare(1.4)).toBe(1);
    expect(Object.is(clampShare(-0), 0)).toBe(true);
    expect(boundsOf([{ x: 0.6, y: 0.1 }, { x: 0.2, y: 0.5 }])).toEqual({ x0: 0.2, y0: 0.1, x1: 0.6, y1: 0.5 });
  });

  it('a mark smaller than 6 points of the screen is a press, not a mark', () => {
    const size = { width: 600, height: 800 };
    expect(isMarkTooSmall([{ x: 0.1, y: 0.1 }, { x: 0.105, y: 0.105 }], size)).toBe(true);
    expect(isMarkTooSmall([{ x: 0.1, y: 0.1 }, { x: 0.12, y: 0.1 }], size)).toBe(false);
  });

  it('draws the same shape at any scale; the number stands at the start of the shape, of an arrow — at its tail', () => {
    const rect = { tool: 'rect' as const, points: [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.25 }] };
    expect(markPath(rect, 400, 800)).toBe('M 100 200 H 200 V 400 H 100 Z');
    expect(markPath(rect, 800, 1600)).toBe('M 200 400 H 400 V 800 H 200 Z');
    expect(markPath({ tool: 'ellipse', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }] }, 400, 400)).toBe('M 0 100 A 100 100 0 1 0 200 100 A 100 100 0 1 0 0 100 Z');
    const pen = markPath({ tool: 'pen', points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }] }, 100, 100);
    expect(pen).toBe('M 0 0 Q 50 0 50 25 L 50 50');
    const arrow = markPath({ tool: 'arrow', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }, 100, 100);
    expect(arrow.startsWith('M 0 50 L 100 50 M ')).toBe(true);
    expect(badgeAt(rect)).toEqual({ x: 0.25, y: 0.25 });
    expect(badgeAt({ tool: 'arrow', points: [{ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.1 }] })).toEqual({ x: 0.9, y: 0.9 });
  });
});

describe('the text under a mark', () => {
  it('takes the words a frame covers — a piece covered in part, by whole words', () => {
    // Over «30 дней» of the first line: x from 250 to 300 points.
    const frame = { tool: 'rect' as const, points: [{ x: 250 / 600, y: (800 - 715) / 800 }, { x: 300 / 600, y: (800 - 695) / 800 }] };
    expect(textUnder(frame, page, ASPECT)).toBe('30 дней');
  });

  it('reads lines from the top down; pieces of a line are joined with a space where they stand apart', () => {
    const frame = { tool: 'ellipse' as const, points: [{ x: 0.05, y: (800 - 716) / 800 }, { x: 0.95, y: (800 - 676) / 800 }] };
    expect(textUnder(frame, page, ASPECT)).toBe('Оплата производится в течение 30 дней Покупатель, обязуется оплатить');
  });

  it('a line of the pen takes the text with a little room round it: an underline takes its words', () => {
    // Under «Покупатель,»: a line just below the baseline.
    const line = { tool: 'pen' as const, points: [{ x: 62 / 600, y: (800 - 677) / 800 }, { x: 120 / 600, y: (800 - 677) / 800 }] };
    expect(textUnder(line, page, ASPECT)).toBe('Покупатель,');
  });

  it('an arrow takes the line its tip points at, from a little way off; far from any text — nothing', () => {
    const arrow = { tool: 'arrow' as const, points: [{ x: 0.9, y: 0.9 }, { x: 250 / 600, y: (800 - 670) / 800 }] };
    expect(textUnder(arrow, page, ASPECT)).toBe('Покупатель, обязуется оплатить');
    const nowhere = { tool: 'arrow' as const, points: [{ x: 0.9, y: 0.1 }, { x: 0.9, y: 0.95 }] };
    expect(textUnder(nowhere, page, ASPECT)).toBe('');
  });

  it('an arrow from below whose tip stops between two lines takes the line it points into', () => {
    // Lines 14 points apart; the tip 1.5 points under the upper one, 0.5 over the lower one, coming from below.
    const lines = textBoxes([item('Иванова Ивана Ивановича', 60, 700, 150), item('на основании Устава', 60, 686, 120)], viewport);
    const arrow = { tool: 'arrow' as const, points: [{ x: 0.3, y: 0.25 }, { x: 120 / 600, y: 101.5 / 800 }] };
    expect(textUnder(arrow, lines, ASPECT)).toBe('Иванова Ивана Ивановича');
  });

  it('a loop of the pen takes only what it goes round, not the lines next to it', () => {
    // A table: a head, a row, the next row; the loop round «15 000,00» of the middle one.
    const table = textBoxes([item('Цена, руб.', 300, 720, 60), item('15 000,00', 300, 700, 54), item('8 500,00', 300, 680, 48)], viewport);
    const loop = { tool: 'pen' as const, points: [{ x: 296 / 600, y: 85 / 800 }, { x: 358 / 600, y: 84 / 800 }, { x: 358 / 600, y: 103 / 800 }, { x: 296 / 600, y: 103 / 800 }] };
    expect(textUnder(loop, table, ASPECT)).toBe('15 000,00');
  });

  it('a line of the pen through the words takes them', () => {
    const strike = { tool: 'pen' as const, points: [{ x: 62 / 600, y: (800 - 684) / 800 }, { x: 120 / 600, y: (800 - 684) / 800 }] };
    expect(textUnder(strike, page, ASPECT)).toBe('Покупатель,');
  });

  it('a long text is cut at 300 characters and ends with «…»', () => {
    const long = textBoxes([item('слово '.repeat(80).trim(), 0, 700, 600)], viewport);
    const quote = textUnder({ tool: 'rect', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, long, ASPECT);
    expect(quote).toBe(`${'слово '.repeat(50).trimEnd()}…`);
  });

  it('a turned page keeps the boxes of its text inside the page as it is shown', () => {
    const turned = { width: 800, height: 600, convertToViewportPoint: (x: number, y: number) => [y, x] };
    const [box] = textBoxes([item('Итого', 100, 200, 50)], turned);
    expect(box).toMatchObject({ text: 'Итого', x0: 200 / 800, y0: 100 / 600 });
    expect(box!.x1).toBeCloseTo(212 / 800);
    expect(box!.y1).toBeCloseTo(150 / 600);
  });
});

describe('the message to the agent', () => {
  const document = { name: 'Договор.docx', path: 'Договор.docx' };
  const picture = { name: 'Договор.docx (пометки).jpg', path: '.marks/Договор.docx (пометки).jpg' };

  it('numbers the marks, names the page, the shape, the comment and the text under each; the document and the picture are attached', () => {
    const text = marksMessage({
      document,
      picture,
      paged: true,
      marks: [
        { tool: 'rect', page: 3, comment: 'срок оплаты 10 дней, а не 30', quote: 'Оплата производится в течение 30 дней' },
        { tool: 'arrow', page: 3, comment: 'лишняя запятая\nи пробел', quote: 'Покупатель, обязуется' },
        { tool: 'pen', page: 5, comment: '  ', quote: '' },
      ],
    });
    expect(splitAttachments(text)).toEqual({
      text: [
        'Пометки к документу «Договор.docx» — 3:',
        '1. Стр. 3, прямоугольник: срок оплаты 10 дней, а не 30',
        '   Под пометкой: «Оплата производится в течение 30 дней»',
        '2. Стр. 3, стрелка: лишняя запятая',
        '   и пробел',
        '   У стрелки: «Покупатель, обязуется»',
        '3. Стр. 5, карандаш — без комментария',
      ].join('\n'),
      files: [document, picture],
    });
  });

  it('a picture has no pages', () => {
    const text = marksMessage({ document: { name: 'фото.png', path: 'фото.png' }, picture, paged: false, marks: [{ tool: 'ellipse', page: 1, comment: 'обрезать', quote: '' }] });
    expect(splitAttachments(text).text).toBe('Пометки к картинке «фото.png» — 1:\n1. Овал: обрезать');
  });
});
