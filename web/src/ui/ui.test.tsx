import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.tsx';
import { Collapse } from './Collapse.tsx';
import { DelayedBar, SLOW_LOAD_MS } from './Loading.tsx';
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

describe('modal under a double click', () => {
  // A double click on a row that opens a dialog: its second click lands on the scrim of the new dialog
  // (a found file, section 8.21) — the dialog stays; a single click on the scrim closes it.
  it('closes on a single click of the scrim, not on the second click of a double one', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} label="Файл">
        <p>Окно файла</p>
      </Modal>,
    );
    const scrim = document.querySelector('[aria-hidden="true"]') as HTMLButtonElement;
    fireEvent.click(scrim, { detail: 2 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(scrim, { detail: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('collapse', () => {
  it('folds the content away only after its animation, and turns back from midway', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const animations: { onfinish: (() => void) | null; cancel: () => void }[] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => {
        const animation = { onfinish: null, cancel: vi.fn() };
        animations.push(animation);
        return animation;
      },
    });
    function Probe() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen((v) => !v)}>
            Подробнее
          </button>
          <Collapse open={open}>
            <p>Что спросили и что нашли</p>
          </Collapse>
        </>
      );
    }
    try {
      render(<Probe />);
      const user = userEvent.setup();
      expect(screen.queryByText('Что спросили и что нашли')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Подробнее' }));
      expect(screen.getByText('Что спросили и что нашли')).toBeInTheDocument();
      expect(animations).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Подробнее' }));
      expect(animations[0]!.cancel).toHaveBeenCalled();
      expect(screen.getByText('Что спросили и что нашли')).toBeInTheDocument();
      act(() => animations[1]!.onfinish?.());
      expect(screen.queryByText('Что спросили и что нашли')).not.toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });
});

describe('waiting (spec, section 8.22)', () => {
  it('shows nothing while the wait is short and a thin line at the top only after a second', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<DelayedBar />);
      act(() => {
        vi.advanceTimersByTime(SLOW_LOAD_MS - 1);
      });
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole('progressbar', { name: 'Загрузка…' })).toBeInTheDocument();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
