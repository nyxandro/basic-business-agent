import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ME, mockServer } from '../test/fetch-mock.ts';
import { renderApp } from '../test/render.tsx';

const ADMIN = { ...ME, user: { id: 'u0', email: 'igor@example.com', name: 'Игорь' }, isSuperadmin: true, permissions: ['users', 'roles', 'departments', 'limits', 'usage', 'agents', 'org_profile', 'masking', 'connections', 'journal'] };

describe('masking and invites', () => {
  it('saves the switches of what the model must not see', async () => {
    const server = mockServer({ 'GET /app/api/me': { body: ADMIN }, 'GET /app/api/admin/masking': { body: { kinds: ['passport', 'snils'] } }, 'PUT /app/api/admin/masking': { body: { ok: true } } });
    renderApp('/admin/masking');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Электронная почта' }));
    await user.click(screen.getByRole('checkbox', { name: 'СНИЛС' }));
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === 'PUT')?.body).toEqual({ kinds: ['passport', 'email'] });
  });
});
