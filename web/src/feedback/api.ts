// Requests of complaints, samples and the report of value (docs/specs/[20.11.2026]-feedback-and-value.md, section 17).
import type { AdminTicketDto, AdminTicketsResponse, ComplaintResponse, ComplaintStateResponse, ExampleMarksResponse, ExampleSaveResponse, MyTicketDto, MyTicketsResponse, SupportRequestResponse, SupportStatus, ValueReport, WorkKind } from '@bba/contracts';
import { api, apiForm } from '../api/client.ts';

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const complaintState = (threadId: string, turn: number) => api<ComplaintStateResponse>('GET', `/app/api/me/support/turn?${q({ threadId, turn: String(turn) })}`);
export const complain = (threadId: string, turn: number, comment: string) => api<ComplaintResponse>('POST', '/app/api/me/support', { threadId, turn, comment });
// A form of text fields and files (`files`): a request and a message of either side.
function formOf(fields: Record<string, string>, files: readonly File[]): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const f of files) form.append('files', f);
  return form;
}

const ME = '/app/api/me/support';
const mine = (id: string) => `${ME}/${encodeURIComponent(id)}`;
export const myTickets = () => api<MyTicketsResponse>('GET', ME);
export const myTicket = (id: string) => api<MyTicketDto>('GET', mine(id));
export const sendRequest = (subject: string, text: string, files: readonly File[]) => apiForm<SupportRequestResponse>(`${ME}/requests`, formOf({ subject, text }, files));
export const writeMine = (id: string, text: string, files: readonly File[]) => apiForm<{ messageId: string }>(`${mine(id)}/messages`, formOf({ text }, files));
export const resolveMine = (id: string) => api<MyTicketDto>('POST', `${mine(id)}/resolve`, {});
export const myFileUrl = (id: string, ord: number) => `${mine(id)}/files/${ord}`;

export const exampleMarks = (threadId: string) => api<ExampleMarksResponse>('GET', `/app/api/me/examples?${q({ threadId })}`);
export const saveExample = (body: { threadId: string; path: string; base: { scope: 'org' } | { scope: 'department'; departmentId: string } }) => api<ExampleSaveResponse>('POST', '/app/api/me/examples', body);
export const removeExample = (threadId: string, path: string) => api<{ ok: true }>('DELETE', `/app/api/me/examples?${q({ threadId, path })}`);

const S = '/app/api/admin/support';
export const tickets = (status: SupportStatus | null) => api<AdminTicketsResponse>('GET', status ? `${S}?${q({ status })}` : S);
export const ticket = (id: string) => api<AdminTicketDto>('GET', `${S}/${encodeURIComponent(id)}`);
export const writeAsSupport = (id: string, text: string, files: readonly File[]) => apiForm<{ messageId: string }>(`${S}/${encodeURIComponent(id)}/messages`, formOf({ text }, files));
export const setTicketStatus = (id: string, status: 'resolved' | 'rejected' | 'open') => api<AdminTicketDto>('POST', `${S}/${encodeURIComponent(id)}/status`, { status });
export const ticketFileUrl = (id: string, ord: number) => `${S}/${encodeURIComponent(id)}/files/${ord}`;

export const valueReport = (from: string, to: string) => api<ValueReport>('GET', `/app/api/admin/value?${q({ from, to })}`);
export const valueCsvUrl = (from: string, to: string) => `/app/api/admin/value.csv?${q({ from, to })}`;
export const saveNorms = (norms: Record<WorkKind, number>, hourRub: number | null) => api<{ ok: true }>('PUT', '/app/api/admin/value-norms', { norms, hourRub });
