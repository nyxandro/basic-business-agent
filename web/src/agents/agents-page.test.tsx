import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

describe('agents list', () => {
  it('says how to get an agent when none is open', async () => {
    mockServer({ 'GET /app/api/me': { body: ME }, 'GET /app/api/agents': { body: { agents: [] } } });
    renderApp('/');
    expect(await screen.findByText('Вам пока не открыт ни один агент. Администратор назначает агентов через отделы — напишите ему.')).toBeInTheDocument();
  });

  it('shows the failure with a repeat, and the repeat shows the agents', async () => {
    const server = mockServer({
      'GET /app/api/me': { body: ME },
      'GET /app/api/agents': apiError('APP_INTERNAL', 'Что-то пошло не так на сервере.', 500),
    });
    renderApp('/');
    expect(await screen.findByText('Не удалось загрузить список агентов')).toBeInTheDocument();

    server.set('GET /app/api/agents', { body: { agents: [{ id: 'sales', name: 'Продажи', description: 'Сделки и клиенты', starters: [] }] } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }));
    const link = await screen.findByRole('link', { name: /Продажи/ });
    expect(link).toHaveAttribute('href', '/agents/sales');
  });

  it('turns an answer the server could not describe into a plain message with a code', async () => {
    const server = mockServer({ 'GET /app/api/me': { body: ME } });
    server.set('GET /app/api/agents', { status: 502, raw: '<html>Bad Gateway</html>' });
    renderApp('/');
    expect(await screen.findByText(/Сервер сейчас не отвечает/)).toBeInTheDocument();
    expect(screen.getByText(/APP_SERVER_UNAVAILABLE/)).toBeInTheDocument();
  });
});
