// The agent's mark chosen in «Интерфейс» (spec, section 8.17): next to its words, its «думает…»,
// its question and on the welcome of a new conversation; with «Без значка» — nowhere.
import type { AgentMark } from '@bba/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { AgentMarkView } from './AgentMark.tsx';

const AGENTS = [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [], actions: {}, systems: { tools: {}, prefixes: {} } }];

function openNewConversation(agentMark: AgentMark) {
  mockServer({
    'GET /app/api/me': { body: { ...ME, interface: { agentMark } } },
    'GET /app/api/agents': { body: { agents: AGENTS } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' } } } },
  });
  renderApp('/');
}
const marks = () => document.querySelectorAll('[data-agent-mark]');

describe('the agent mark', () => {
  it('is the chosen icon, the picture or nothing at all', () => {
    const { container, rerender } = render(<AgentMarkView mark={{ kind: 'icon', icon: 'bot' }} />);
    expect(container.querySelector('[data-agent-mark="icon"][data-icon="bot"] svg')).not.toBeNull();
    rerender(<AgentMarkView mark={{ kind: 'image', url: '/app/api/interface/agent-image?v=0123456789ab' }} />);
    const picture = container.querySelector('[data-agent-mark="image"] img');
    expect(picture).toHaveAttribute('src', '/app/api/interface/agent-image?v=0123456789ab');
    // Decorative: a picture that did not load is not announced and shows no broken-image sign.
    expect(picture).toHaveAttribute('alt', '');
    rerender(<AgentMarkView mark={{ kind: 'none' }} />);
    expect(container.querySelector('[data-agent-mark]')).toBeNull();
  });

  it('greets a new conversation with the admin’s picture', async () => {
    openNewConversation({ kind: 'image', url: '/app/api/interface/agent-image?v=0123456789ab' });
    expect(await screen.findByText('Сделки и клиенты')).toBeInTheDocument();
    expect([...marks()].map((m) => m.getAttribute('data-agent-mark'))).toEqual(['image']);
  });

  it('greets a new conversation without a mark when «Без значка» is chosen', async () => {
    openNewConversation({ kind: 'none' });
    expect(await screen.findByText('Сделки и клиенты')).toBeInTheDocument();
    expect(marks()).toHaveLength(0);
  });
});
