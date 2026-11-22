// Background tasks by an event (docs/specs/[20.11.2026]-event-tasks.md, section 23): the admin makes a task on a message
// of another system and copies its address; a message there starts the agent on behalf of Ольга, its question waits for
// her «Да»; a letter in her mailbox starts a mail task. The conversations of a task's events are one row of «Недавние».
import { deliver, testMailbox } from '../../core/mail/test-server.ts';
import { expect, pageAs, test } from './helpers.ts';

test('a message to the address of a task starts the agent on behalf of its executor, whose «Да» runs the action', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/modes');
  await admin.getByRole('button', { name: 'Новая задача' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Новая задача' });
  await dialog.getByLabel('Название').fill('Новая сделка');
  await dialog.getByRole('button', { name: 'По событию' }).click();
  await dialog.getByRole('button', { name: 'Сообщение от другой системы' }).click();
  await dialog.getByLabel('От чьего имени работает агент').selectOption({ label: 'Ольга' });
  await dialog.getByLabel('Что сделать агенту').fill('Напиши письмо клиенту по новой сделке');
  await dialog.getByRole('button', { name: 'Создать задачу' }).click();
  const address = (await dialog.locator('code').textContent())!;
  expect(address).toMatch(/\/app\/api\/hooks\/[\w-]+$/);
  await expect(dialog.getByRole('button', { name: 'Скопировать' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(admin.getByRole('cell', { name: 'По событию · сообщения' })).toBeVisible();

  // Another system sends a form, as Bitrix24 does.
  const res = await admin.request.post(address, { form: { event: 'ONCRMDEALADD', 'data[FIELDS][ID]': '77', ts: String(Date.now()) } });
  expect(res.status()).toBe(200);

  const olga = await pageAs(browser, 'olga@example.com');
  await olga.getByRole('link', { name: /Ждёт подтверждения/ }).click();
  const card = olga.getByRole('article').filter({ hasText: 'Новая сделка' });
  await expect(card).toContainText('client@example.com');
  await card.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(card.getByText('Выполнено')).toBeVisible();
  // «Недавние»: the task's events are one row; opened, its conversation of the message.
  await olga.goto('/');
  await olga.getByRole('button', { name: /^Новая сделка · / }).click();
  await expect(olga.getByRole('link', { name: /^Сообщение от другой системы · / })).toBeVisible();
});

test('a letter in the employee’s mailbox starts a mail task in a conversation named after its sender', async ({ browser }) => {
  const box = await testMailbox('olga-e2e');
  const client = await testMailbox('vector-e2e');
  const olga = await pageAs(browser, 'olga@example.com');
  const connected = await olga.request.post('/app/api/me/mail', { data: { email: box.email, provider: 'custom', login: box.email, password: box.password, imap: { host: '127.0.0.1', port: 54993, security: 'tls' }, smtp: { host: '127.0.0.1', port: 54465, security: 'tls' } } });
  expect(connected.status()).toBe(200);
  const admin = await pageAs(browser, 'igor@example.com');
  const me = (await (await olga.request.get('/app/api/me')).json()) as { user: { id: string } };
  const created = await admin.request.post('/app/api/admin/tasks', { data: { title: 'Разбор заказов', agentId: 'sales', trigger: 'mail', access: { scope: 'users', departmentIds: [], userIds: [me.user.id] }, mailFilter: { from: [], subject: ['заказ'] }, prompt: 'Разбери письмо и коротко скажи, что просят.' } });
  expect(created.status()).toBe(201);
  // The date of a letter has whole seconds: it comes in a later one than the task was switched on.
  await new Promise((r) => setTimeout(r, 1100));
  await deliver(box.email, client, { subject: 'Заказ на профнастил С21', text: 'Нужно 120 листов к пятнице.' });
  await expect(async () => {
    await olga.goto('/');
    await olga.getByRole('button', { name: /^Разбор заказов · / }).click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(olga.getByRole('link', { name: /^Письмо от / })).toBeVisible();
  await olga.goto('/settings/connections');
  await expect(olga.getByText(/Ваши новые письма разбирает задача «Разбор заказов»/)).toBeVisible();
});
