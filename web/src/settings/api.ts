import type { MailAccountsResponse, MailConnectInput, MailDiscovery, MailOAuthProvider, MyConnection, MyMcpServer, MyUsage } from '@bba/contracts';
import { api } from '../api/client.ts';

const enc = encodeURIComponent;

export const fetchMyUsage = () => api<MyUsage>('GET', '/app/api/me/usage');

export const fetchConnections = () => api<{ connections: MyConnection[] }>('GET', '/app/api/me/connections');
export const saveStaticConnection = (id: string, fields: Record<string, string>) => api<{ status: MyConnection }>('PUT', `/app/api/me/connections/${enc(id)}`, { fields });
export const disconnect = (id: string) => api<{ ok: true }>('DELETE', `/app/api/me/connections/${enc(id)}`);
export const startOAuth = (id: string) => api<{ url: string }>('POST', `/app/api/me/connections/${enc(id)}/oauth/start`, {});

// MCP servers the admin allowed for the person's agents (docs/specs/[20.11.2026]-mcp-connections.md, scenario 2).
export const fetchMcpServers = () => api<{ servers: MyMcpServer[] }>('GET', '/app/api/me/connections/mcp');
export const setMcpServerUse = (id: string, on: boolean) => api<{ ok: true }>('POST', `/app/api/me/connections/mcp/${enc(id)}/use`, { on });
export const saveMcpKey = (id: string, fields: Record<string, string>) => api<{ status: MyMcpServer['status'] }>('PUT', `/app/api/me/connections/mcp/${enc(id)}`, { fields });
export const signInMcp = (id: string) => api<{ url: string }>('POST', `/app/api/me/connections/mcp/${enc(id)}/sign-in`, {});
export const disconnectMcp = (id: string) => api<{ ok: true }>('DELETE', `/app/api/me/connections/mcp/${enc(id)}`);

// The person's mailbox (spec, section 8.24).
export const fetchMail = () => api<MailAccountsResponse>('GET', '/app/api/me/mail');
export const discoverMail = (email: string) => api<MailDiscovery>('POST', '/app/api/me/mail/discover', { email });
export const connectMail = (input: MailConnectInput) => api<MailAccountsResponse>('POST', '/app/api/me/mail', input);
export const startMailOAuth = (email: string, provider: MailOAuthProvider) => api<{ url: string }>('POST', '/app/api/me/mail/oauth/start', { email, provider });
export const disconnectMail = (id: string) => api<MailAccountsResponse>('DELETE', `/app/api/me/mail/${enc(id)}`);
