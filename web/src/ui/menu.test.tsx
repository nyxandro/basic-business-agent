// A menu over the page (owner's list 16.11): a menu of a table row is not cut by the table's
// scrolling box — it lies in the top layer of the page, at its button, and turns up when there is no
// room below.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuAnchor, MenuItem } from './Menu.tsx';

const VIEW_HEIGHT = 800;
const MENU_HEIGHT = 120;

function rect(r: { top: number; left: number; width: number; height: number }): DOMRect {
  return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r };
}

function RowMenu({ onPick }: { onPick: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ overflow: 'auto', height: 60 }} data-testid="box">
      <MenuAnchor>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          Действия
        </button>
        <Menu open={open} onClose={() => setOpen(false)} label="Действия со строкой" floating>
          <MenuItem onSelect={() => (setOpen(false), onPick())}>Изменить</MenuItem>
        </Menu>
      </MenuAnchor>
    </div>
  );
}

function place(button: HTMLElement, top: number) {
  vi.spyOn(button.parentElement!, 'getBoundingClientRect').mockReturnValue(rect({ top, left: 600, width: 32, height: 32 }));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(MENU_HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(VIEW_HEIGHT);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1200);
}

afterEach(() => vi.restoreAllMocks());

describe('a floating menu', () => {
  it('lies over the page under its button, right edges together, outside the scrolling box', async () => {
    render(<RowMenu onPick={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Действия' });
    place(button, 100);
    await userEvent.setup().click(button);
    const menu = screen.getByRole('menu', { name: 'Действия со строкой' });
    expect(within(screen.getByTestId('box')).queryByRole('menu')).toBeNull();
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).toBe('138px');
    expect(menu.style.left).toBe(`${632 - 220}px`);
  });

  it('turns up when there is no room below its button', async () => {
    render(<RowMenu onPick={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Действия' });
    place(button, 740);
    await userEvent.setup().click(button);
    expect(screen.getByRole('menu').style.top).toBe(`${740 - 6 - MENU_HEIGHT}px`);
  });

  it('works by its items and closes on a click outside, not on a click inside', async () => {
    const onPick = vi.fn();
    render(
      <>
        <RowMenu onPick={onPick} />
        <p>Где-то ещё</p>
      </>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Действия' });
    place(button, 100);
    await user.click(button);
    await user.click(screen.getByText('Где-то ещё'));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(button);
    await user.click(screen.getByRole('menuitem', { name: 'Изменить' }));
    expect(onPick).toHaveBeenCalledOnce();
  });

  it('takes the keyboard to its first item and gives it back to the button on Esc', async () => {
    render(<RowMenu onPick={() => undefined} />);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Действия' });
    place(button, 100);
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Изменить' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });
});
