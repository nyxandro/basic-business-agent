import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { UploadProgress } from './upload-progress.ts';

describe('how far the files going up are (spec, section 8.9)', () => {
  it('gives each file its share and the batch the share of all its bytes', () => {
    const board = new UploadProgress();
    board.begin();
    board.add(1, 1000);
    board.add(2, 3000);
    expect(board.fileShare(1)).toBe(0);
    board.sent(1, 500);
    expect(board.fileShare(1)).toBe(0.5);
    expect(board.batchShare()).toBe(500 / 4000);
    board.finish(1);
    board.sent(2, 1500);
    expect(board.batchShare()).toBe(2500 / 4000);
    board.finish(2);
    expect(board.batchShare()).toBe(1);
  });

  it('starts a new batch from nothing, and tells the rings when something moved', () => {
    const board = new UploadProgress();
    const told = vi.fn();
    const stop = board.subscribe(told);
    board.begin();
    board.add(1, 100);
    board.sent(1, 100);
    board.finish(1);
    board.begin();
    board.add(2, 400);
    expect(board.batchShare()).toBe(0);
    expect(told).toHaveBeenCalled();
    stop();
    told.mockClear();
    board.sent(2, 200);
    expect(told).not.toHaveBeenCalled();
  });

  it('never goes back, never leaves 0–1, and is whole when every file is up', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 12 }), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 40 }), (sizes, steps) => {
        const board = new UploadProgress();
        board.begin();
        sizes.forEach((bytes, id) => board.add(id, bytes));
        let last = board.batchShare();
        // Files go up one after another, as the queue sends them; each in rising steps.
        let step = 0;
        sizes.forEach((bytes, id) => {
          let sent = 0;
          for (let k = 0; k < 3 && step < steps.length; k++, step++) {
            sent = Math.max(sent, steps[step]! * bytes);
            board.sent(id, sent);
            const now = board.batchShare();
            expect(now).toBeGreaterThanOrEqual(last - 1e-12);
            expect(now).toBeGreaterThanOrEqual(0);
            expect(now).toBeLessThanOrEqual(1);
            last = now;
          }
          board.finish(id);
          expect(board.batchShare()).toBeGreaterThanOrEqual(last - 1e-12);
          last = board.batchShare();
        });
        expect(board.batchShare()).toBe(1);
      }),
      { examples: [[[1], []], [[5_000_000, 1], [1, 0, 0.5]]] },
    );
  });
});
