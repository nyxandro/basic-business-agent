// Sign-in goes through Better Auth (/app/api/auth); the server translates its errors to ours.
import type { MeResponse } from '@bba/contracts';
import { api } from '../api/client.ts';

export const fetchMe = () => api<MeResponse>('GET', '/app/api/me');
export const signIn = (email: string, password: string) => api<unknown>('POST', '/app/api/auth/sign-in/email', { email, password });
export const signOut = () => api<unknown>('POST', '/app/api/auth/sign-out', {});

export type PasswordLinkKind = 'invite' | 'reset';

const LINK_PATHS: Record<PasswordLinkKind, string> = { invite: '/app/api/invites', reset: '/app/api/password-resets' };

export const readPasswordLink = (kind: PasswordLinkKind, token: string) =>
  api<{ email: string; name?: string }>('GET', `${LINK_PATHS[kind]}/${encodeURIComponent(token)}`);

export const acceptPasswordLink = (kind: PasswordLinkKind, token: string, password: string) =>
  api<{ email: string }>('POST', `${LINK_PATHS[kind]}/${encodeURIComponent(token)}/accept`, { password });
