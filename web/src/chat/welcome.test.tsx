// The questions to start with on an empty conversation do not leave while there is no connection to the server
// (chat/runtime-recovery.ts): they would go into nowhere (independent review 24.11).
import type { AgentSummary } from '@bba/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Welcome } from './Welcome.tsx';

vi.mock('../auth/session.tsx', () => ({ useMe: () => ({ user: { name: 'Ольга Смирнова' } }) }));
vi.mock('./AgentMark.tsx', () => ({ AgentMark: () => null }));

const agent = { id: 'sales', name: 'Продажи', description: 'Сделки', starters: ['Покажи мои сделки'] } as unknown as AgentSummary;

describe('the questions to start with', () => {
  it('wait while there is no connection, and leave when there is', () => {
    const onStart = vi.fn();
    const { rerender } = render(<Welcome agent={agent} onStart={onStart} offline />);
    const starter = screen.getByRole('button', { name: 'Покажи мои сделки' });
    expect(starter).toBeDisabled();
    fireEvent.click(starter);
    expect(onStart).not.toHaveBeenCalled();
    rerender(<Welcome agent={agent} onStart={onStart} offline={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Покажи мои сделки' }));
    expect(onStart).toHaveBeenCalledWith('Покажи мои сделки');
  });
});
