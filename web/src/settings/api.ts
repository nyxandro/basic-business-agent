import type { MemoryResponse, MyConnection, MyUsage } from '@bba/contracts';
import { api } from '../api/client.ts';

const enc = encodeURIComponent;

export const fetchMemory = () => api<MemoryResponse>('GET', '/app/api/me/memory');
export const saveMemory = (text: string) => api<{ ok: true }>('PUT', '/app/api/me/memory', { text });
export const forgetMemory = () => api<{ ok: true }>('DELETE', '/app/api/me/memory');

export const fetchMyUsage = () => api<MyUsage>('GET', '/app/api/me/usage');

export const fetchConnections = () => api<{ connections: MyConnection[] }>('GET', '/app/api/me/connections');
export const saveStaticConnection = (id: string, fields: Record<string, string>) => api<{ status: MyConnection }>('PUT', `/app/api/me/connections/${enc(id)}`, { fields });
export const disconnect = (id: string) => api<{ ok: true }>('DELETE', `/app/api/me/connections/${enc(id)}`);
export const startOAuth = (id: string) => api<{ url: string }>('POST', `/app/api/me/connections/${enc(id)}/oauth/start`, {});
