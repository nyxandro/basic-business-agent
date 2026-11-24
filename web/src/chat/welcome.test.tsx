// An empty conversation greets the person and says what the agent does — with no questions to start with: the owner
// removed them on 24.11 («никаких подсказок в пустом чате не нужно»).
import type { AgentSummary } from '@bba/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Welcome } from './Welcome.tsx';

vi.mock('../auth/session.tsx', () => ({ useMe: () => ({ user: { name: 'Ольга Смирнова' } }) }));
vi.mock('./AgentMark.tsx', () => ({ AgentMark: () => null }));

const agent = { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты' } as AgentSummary;

describe('an empty conversation', () => {
  it('greets by the first name and says what the agent does, with no buttons to start with', () => {
    render(<Welcome agent={agent} />);
    expect(screen.getByRole('heading', { name: /Ольга/ })).toBeInTheDocument();
    expect(screen.getByText('Сделки и клиенты')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
