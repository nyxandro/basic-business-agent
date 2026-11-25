// The scrolling area of the side panel (owner 25.11): its scrollbar shows only while it scrolls and fades out after, sits
// where the list is, and can be dragged with the mouse.
import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_IDLE_MS, ScrollArea } from './ScrollArea.tsx';

// jsdom has no layout: the visible height and the height of the content are given by hand.
function area(visible: number, content: number) {
  const { container, unmount } = render(
    <ScrollArea>
      <p>Строка</p>
    </ScrollArea>,
  );
  const root = container.firstElementChild as HTMLElement;
  const viewport = root.firstElementChild as HTMLElement;
  const thumb = root.lastElementChild as HTMLElement;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: visible });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: content });
  return { root, viewport, thumb, unmount };
}

function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  fireEvent.scroll(viewport);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ScrollArea', () => {
  it('shows the thumb while the list scrolls and lets it fade after a pause', () => {
    vi.useFakeTimers();
    const { root, viewport } = area(200, 1000);
    expect(root).not.toHaveAttribute('data-scrolling');
    scrollTo(viewport, 100);
    expect(root).toHaveAttribute('data-overflow');
    expect(root).toHaveAttribute('data-scrolling');
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);
    // Scrolling on keeps it.
    scrollTo(viewport, 200);
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 100);
    expect(root).toHaveAttribute('data-scrolling');
    vi.advanceTimersByTime(100);
    expect(root).not.toHaveAttribute('data-scrolling');
  });

  it('has no thumb when everything fits', () => {
    const { root, viewport } = area(500, 500);
    scrollTo(viewport, 0);
    expect(root).not.toHaveAttribute('data-overflow');
  });

  // The way of the thumb is the visible height less 4 px at each end; its length is the visible part of the list.
  it('puts the thumb where the list is, as long as the visible part', () => {
    const { viewport, thumb } = area(200, 1000);
    scrollTo(viewport, 0);
    expect(thumb.style.height).toBe('38.4px');
    expect(thumb.style.transform).toBe('translateY(4px)');
    scrollTo(viewport, 800);
    expect(thumb.style.transform).toBe('translateY(157.6px)');
  });

  it('keeps a short thumb long enough to catch on a long list', () => {
    const { viewport, thumb } = area(200, 100_000);
    scrollTo(viewport, 0);
    expect(thumb.style.height).toBe('24px');
  });

  it('scrolls the list as the thumb is dragged, and stays shown meanwhile', () => {
    vi.useFakeTimers();
    const { root, viewport, thumb } = area(200, 1000);
    scrollTo(viewport, 0);
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientY: 10 });
    expect(root).toHaveAttribute('data-dragging');
    // 153.6 px of the thumb's way are 800 px of the list.
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientY: 10 + 76.8 });
    expect(viewport.scrollTop).toBeCloseTo(400);
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientY: 10 + 500 });
    expect(viewport.scrollTop).toBeCloseTo(800);
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 510 });
    expect(root).not.toHaveAttribute('data-dragging');
    // After the hand let go, the list no longer follows the pointer.
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientY: 10 });
    expect(viewport.scrollTop).toBeCloseTo(800);
  });

  // Alt+Tab in the middle of a drag: the release never reaches the page.
  it('stops the drag when the pointer moves with the button already let go', () => {
    const { root, viewport, thumb } = area(200, 1000);
    scrollTo(viewport, 0);
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientY: 10 + 76.8 });
    expect(viewport.scrollTop).toBe(0);
    expect(root).not.toHaveAttribute('data-dragging');
  });

  // The lists of the panel load after it shows: the thumb learns there is more without any scroll.
  it('learns that the content grew without a scroll', () => {
    const seen: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          seen.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const { root, thumb } = area(200, 1000);
    expect(root).not.toHaveAttribute('data-overflow');
    for (const callback of seen) callback([], {} as ResizeObserver);
    expect(root).toHaveAttribute('data-overflow');
    expect(root).not.toHaveAttribute('data-scrolling');
    expect(thumb.style.height).toBe('38.4px');
  });

  it('lets go of the window when it goes away in the middle of a drag', () => {
    const { viewport, thumb, unmount } = area(200, 1000);
    scrollTo(viewport, 0);
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientY: 10 });
    unmount();
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientY: 10 + 76.8 });
    expect(viewport.scrollTop).toBe(0);
  });
});
