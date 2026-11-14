// Criteria 1 and 5 of the spec (section 23) and the chat of step 17, in a browser.
import { expect, test } from '@playwright/test';
import { newConversation, openAgent, say, pageAs } from './helpers.ts';

test('an employee sees only the agents of their department', async ({ browser }) => {
  const page = await pageAs(browser, 'petr@example.com');
  await expect(page.getByRole('link', { name: /Помощник/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Продажи/ })).toHaveCount(0);
});

test('the catalog blocks are drawn, broken data is shown as text', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Покажи таблицу сделок');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await say(page, 'Нарисуй график');
  await expect(page.getByRole('img', { name: 'Выручка по месяцам' })).toBeVisible();
  await say(page, 'Покажи карточку сделки');
  await expect(page.getByRole('heading', { name: 'Поставка бетона' })).toBeVisible();
  await say(page, 'Сломанный график');
  await expect(page.getByText('Не удалось показать данные')).toBeVisible();
});

test('an action waits for «Да»: «Нет» cancels it, «Да» runs it and the journal shows it', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Напиши письмо клиенту');
  await expect(page.getByText('Подтвердите действие')).toBeVisible();
  await page.getByRole('button', { name: 'Нет' }).click();
  await expect(page.getByText('Действие отменено')).toBeVisible();

  await say(page, 'Всё-таки напиши письмо');
  await page.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(page.getByText('Письмо отправлено.')).toBeVisible();

  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/journal');
  const row = admin.getByRole('row').filter({ hasText: 'mail_send' }).filter({ hasText: 'Ольга' }).first();
  await expect(row).toContainText('Выполнено');
  await expect(row).toContainText('«Да» — Ольга');
  await admin.close();
});

test('a new message instead of an answer cancels the waiting action', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Напиши письмо клиенту');
  await expect(page.getByText('Подтвердите действие')).toBeVisible();
  await say(page, 'Нет, лучше покажи таблицу');
  await expect(page.getByText('Отменено: вы написали новое сообщение')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
});

test('an action a sub-agent wants waits for «Да» in the chat too', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Помощник');
  await newConversation(page);
  await say(page, 'Попроси почтальона отправить письмо');
  await expect(page.getByText('Подтвердите действие')).toBeVisible();
  await page.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(page.getByRole('button', { name: /Поручение агенту «Почтальон»/ })).toBeVisible();
  await expect(page.getByText('Подтвердите действие')).toHaveCount(0);
});

test('a reload keeps the conversation and the unsent text', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Покажи таблицу сделок');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Сообщение агенту' }).fill('Черновик вопроса');
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Сообщение агенту' })).toHaveValue('Черновик вопроса');
});
