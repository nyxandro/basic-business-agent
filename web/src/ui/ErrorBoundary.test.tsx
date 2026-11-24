import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { uiErrorTexts } from '../i18n/ui-errors.ts';
import { ErrorBoundary, PartBoundary } from './ErrorBoundary.tsx';

function Broken(): never {
  throw new Error('render failed');
}

describe('a screen that failed to draw', () => {
  it('shows a plain message with its code instead of a blank page', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Экран не открылся');
    expect(screen.getByText(/APP_UI_FAILED/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Обновить страницу' })).toBeInTheDocument();
    expect(log).toHaveBeenCalledWith('ui render failed', expect.any(Error), expect.anything());
  });
});

describe('a part of a screen that failed to draw', () => {
  it('shows a short note in its place, and the rest of the screen stays', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <p>Первое сообщение</p>
        <PartBoundary>
          <Broken />
        </PartBoundary>
        <p>Третье сообщение</p>
      </div>,
    );
    expect(screen.getByText(uiErrorTexts.partFailed)).toBeInTheDocument();
    expect(screen.getByText(/APP_UI_PART_FAILED/)).toBeInTheDocument();
    expect(screen.getByText('Первое сообщение')).toBeInTheDocument();
    expect(screen.getByText('Третье сообщение')).toBeInTheDocument();
    expect(log).toHaveBeenCalledWith('ui part render failed', expect.any(Error), expect.anything());
  });
});
