import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';
import { Switch } from './Switch.tsx';
import { THEME_STORAGE_KEY } from './theme/theme.ts';
import { ThemeProvider, useTheme } from './theme/ThemeProvider.tsx';
import { stubSystemTheme } from '../test/match-media.ts';

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span>тема: {theme}</span>
      <button type="button" onClick={() => setTheme('dark')}>
        Тёмная
      </button>
    </div>
  );
}

describe('theme', () => {
  it('follows the system until the person chooses, then keeps the choice in the browser', async () => {
    const system = stubSystemTheme('dark');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByText('тема: dark')).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => system.change('light'));
    expect(document.documentElement.dataset.theme).toBe('light');

    await userEvent.click(screen.getByRole('button', { name: 'Тёмная' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    act(() => system.change('light'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('takes the stored choice over the system one', () => {
    stubSystemTheme('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByText('тема: light')).toBeInTheDocument();
  });
});

describe('switch', () => {
  it('is a switch with its state and name', async () => {
    function Probe() {
      const [on, setOn] = useState(false);
      return <Switch label="Электронная почта" checked={on} onChange={setOn} />;
    }
    render(<Probe />);
    const sw = screen.getByRole('switch', { name: 'Электронная почта' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('modal', () => {
  it('closes on Esc and gives the focus back to the button that opened it', async () => {
    function Probe() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Открыть поиск</Button>
          <Modal open={open} onClose={() => setOpen(false)} label="Поиск">
            <input aria-label="Запрос" />
          </Modal>
        </>
      );
    }
    render(<Probe />);
    const opener = screen.getByRole('button', { name: 'Открыть поиск' });
    await userEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Поиск' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Запрос' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
