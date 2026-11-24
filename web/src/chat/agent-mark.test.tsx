// The agent's own mark (spec, section 8.17; decision of the owner 16.11): next to its words, its
// «думает…», its question and on the welcome of a new conversation; each agent its own; with the
// marks turned off in «Интерфейс» — nowhere.
import type { AgentMark } from '@bba/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';
import { AgentMarkView } from './AgentMark.tsx';

const PICTURE_URL = '/app/api/agents/sales/image?v=0123456789ab';
const agents = (mark: AgentMark) => [
  { id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', mark, actions: {}, systems: { tools: {}, prefixes: {} } },
  { id: 'assistant', name: 'Общий помощник', description: 'Вопросы и заметки', mark: { kind: 'icon', icon: 'star' }, actions: {}, systems: { tools: {}, prefixes: {} } },
];

function openNewConversation(mark: AgentMark, showAgentMark = true, path = '/agents/sales') {
  mockServer({
    'GET /app/api/me': { body: { ...ME, interface: { showAgentMark } } },
    'GET /app/api/agents': { body: { agents: agents(mark) } },
    'GET /app/api/threads': { body: { threads: [], next: null } },
    'GET /app/api/me/usage': { body: { month: { spentRub: 0, limitRub: null, resetsOn: '2026-12-01' }, daily: null } },
    'GET /app/api/copilotkit/info': { body: { version: '2.0.0', agents: { sales: { name: 'sales', description: '', className: 'MastraAgent' }, assistant: { name: 'assistant', description: '', className: 'MastraAgent' } } } },
  });
  renderApp(path);
}
const marks = () => document.querySelectorAll('[data-agent-mark]');

describe('the agent mark', () => {
  it('is the chosen icon or the picture', () => {
    const { container, rerender } = render(<AgentMarkView mark={{ kind: 'icon', icon: 'bot' }} />);
    expect(container.querySelector('[data-agent-mark="icon"][data-icon="bot"] svg')).not.toBeNull();
    rerender(<AgentMarkView mark={{ kind: 'image', url: PICTURE_URL }} />);
    const picture = container.querySelector('[data-agent-mark="image"] img');
    expect(picture).toHaveAttribute('src', PICTURE_URL);
    // Decorative: a picture that did not load is not announced and shows no broken-image sign.
    expect(picture).toHaveAttribute('alt', '');
  });

  it('greets a new conversation with the picture of its agent', async () => {
    openNewConversation({ kind: 'image', url: PICTURE_URL });
    expect(await screen.findByText('Сделки и клиенты')).toBeInTheDocument();
    expect([...marks()].map((m) => m.getAttribute('data-agent-mark'))).toEqual(['image']);
  });

  it('is the mark of the conversation’s own agent', async () => {
    openNewConversation({ kind: 'image', url: PICTURE_URL }, true, '/agents/assistant');
    expect(await screen.findByText('Вопросы и заметки')).toBeInTheDocument();
    expect([...marks()].map((m) => m.getAttribute('data-icon'))).toEqual(['star']);
  });

  it('greets a new conversation without a mark when the marks are turned off', async () => {
    openNewConversation({ kind: 'image', url: PICTURE_URL }, false);
    expect(await screen.findByText('Сделки и клиенты')).toBeInTheDocument();
    expect(marks()).toHaveLength(0);
  });
});
