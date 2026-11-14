import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.tsx';

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
