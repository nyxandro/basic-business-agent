// Requests of complaints, samples and the report of value (docs/specs/[20.11.2026]-feedback-and-value.md, section 17).
import type { AdminTicketDto, AdminTicketsResponse, ComplaintResponse, ComplaintStateResponse, ExampleSaveResponse, ExampleStateResponse, MyTicketsResponse, SupportStatus, ValueReport, WorkKind } from '@bba/contracts';
import { api } from '../api/client.ts';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const complaintState = (threadId: string, turn: number) => api<ComplaintStateResponse>('GET', `/app/api/me/support/turn?${q({ threadId, turn: String(turn) })}`);
export const complain = (threadId: string, turn: number, comment: string) => api<ComplaintResponse>('POST', '/app/api/me/support', { threadId, turn, comment });
export const myTickets = () => api<MyTicketsResponse>('GET', '/app/api/me/support');

export const exampleState = (threadId: string, path: string) => api<ExampleStateResponse>('GET', `/app/api/me/examples?${q({ threadId, path })}`);
export const saveExample = (body: { threadId: string; path: string; docType: string; base: { scope: 'org' } | { scope: 'department'; departmentId: string } }) => api<ExampleSaveResponse>('POST', '/app/api/me/examples', body);

const S = '/app/api/admin/support';
export const tickets = (status: SupportStatus | null) => api<AdminTicketsResponse>('GET', status ? `${S}?${q({ status })}` : S);
export const ticket = (id: string) => api<AdminTicketDto>('GET', `${S}/${encodeURIComponent(id)}`);
export const updateTicket = (id: string, body: { status: SupportStatus; reply: string | null; seen: string }) => api<AdminTicketDto>('PATCH', `${S}/${encodeURIComponent(id)}`, body);
export const ticketFileUrl = (id: string, ord: number) => `${S}/${encodeURIComponent(id)}/files/${ord}`;

export const valueReport = (from: string, to: string) => api<ValueReport>('GET', `/app/api/admin/value?${q({ from, to })}`);
export const valueCsvUrl = (from: string, to: string) => `/app/api/admin/value.csv?${q({ from, to })}`;
export const saveNorms = (norms: Record<WorkKind, number>, hourRub: number | null) => api<{ ok: true }>('PUT', '/app/api/admin/value-norms', { norms, hourRub });
