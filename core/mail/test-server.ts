// Test helper: the mail server of the tests (deploy/compose.dev.yaml, service mail-test) — people made through
// its API, letters put by SMTP, mailboxes read by IMAP. Ports are fixed there; the certificate is its own.
import { randomBytes } from 'node:crypto';
import type { MailServers } from '@bba/contracts';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export const TEST_MAIL_SERVERS: MailServers = { imap: { host: '127.0.0.1', port: 54993, security: 'tls' }, smtp: { host: '127.0.0.1', port: 54465, security: 'tls' } };
const API = 'http://127.0.0.1:54480/api';

export async function testMailReady(): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`${API}/service/readiness`).then((r) => r.ok, () => false);
    if (ok) return;
    if (Date.now() > until) throw new Error('the test mail server does not answer: start it with pnpm dev:db');
    await new Promise((r) => setTimeout(r, 500));
  }
}

// A person on the test mail server with an address of their own for this run.
export async function testMailbox(name: string): Promise<{ email: string; password: string }> {
  const email = `${name}-${randomBytes(4).toString('hex')}@alfa.test`;
  const password = `pass-${randomBytes(6).toString('hex')}`;
  const res = await fetch(`${API}/user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, login: email, password }) });
  if (!res.ok) throw new Error(`test mail server did not create ${email}: ${res.status}`);
  return { email, password };
}

// `messageId` and `headers` make a copy of one letter to several mailboxes, or an automatic reply.
export async function deliver(
  to: string | string[],
  from: { email: string; password: string },
  letter: { subject: string; text: string; attachments?: { filename: string; content: string }[]; messageId?: string; headers?: Record<string, string> },
): Promise<void> {
  const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 54465, secure: true, auth: { user: from.email, pass: from.password }, tls: { rejectUnauthorized: false } });
  try {
    await smtp.sendMail({
      from: from.email,
      to,
      subject: letter.subject,
      text: letter.text,
      ...(letter.attachments ? { attachments: letter.attachments } : {}),
      ...(letter.messageId ? { messageId: letter.messageId } : {}),
      ...(letter.headers ? { headers: letter.headers } : {}),
    });
  } finally {
    smtp.close();
  }
}

// Subjects, texts and the «read» mark of the letters in a mailbox's INBOX.
export async function inbox(who: { email: string; password: string }): Promise<{ subject: string; source: string; seen: boolean }[]> {
  const client = new ImapFlow({ host: '127.0.0.1', port: 54993, secure: true, auth: { user: who.email, pass: who.password }, tls: { rejectUnauthorized: false }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const out: { subject: string; source: string; seen: boolean }[] = [];
      if ((client.mailbox && client.mailbox.exists) === 0) return out;
      for await (const m of client.fetch('1:*', { envelope: true, flags: true, source: true })) out.push({ subject: m.envelope?.subject ?? '', source: m.source?.toString('utf8') ?? '', seen: m.flags?.has('\\Seen') ?? false });
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
