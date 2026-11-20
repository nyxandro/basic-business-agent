// Criteria 1 and 5 of the spec (section 23) and the chat of step 17, in a browser.
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { AFTER_ANSWER_AGAIN, AFTER_ONE_BREAK } from './stand-model.ts';

test('an employee sees only the agents of their department', async ({ browser }) => {
  const page = await pageAs(browser, 'petr@example.com');
  await expect(page.getByRole('link', { name: /Помощник/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Продажи/ })).toHaveCount(0);
});

// Spec, section 8.31: the agent draws its screens; one the server refuses leaves no trace but the answer in words.
test('widgets are drawn in the chat; a screen the server refuses is answered with text', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Покажи таблицу сделок');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await say(page, 'Нарисуй график');
  await expect(page.getByRole('img', { name: 'Выручка по месяцам' })).toBeVisible();
  await say(page, 'Покажи карточку сделки');
  await expect(page.getByRole('heading', { name: 'Поставка бетона' })).toBeVisible();
  await say(page, 'Сломанный экран: склады на карте');
  await expect(page.getByText('Экран не получился, отвечу текстом')).toBeVisible();
  await expect(page.getByText('Собираю экран заново')).toHaveCount(0);
  await expect(page.locator('[data-generative-ui-error]')).toHaveCount(0);
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

// Spec, section 9.1: the model breaks off mid-answer.
test('a broken answer: a repeat makes it whole; one that stays broken keeps its error after a reload and is answered again', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  const id = Date.now();

  await say(page, `Проверка: обрыв один раз ${id}`);
  await expect(page.getByText(AFTER_ONE_BREAK)).toBeVisible();
  await expect(page.getByText('Начинаю отвечать на вопрос')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ответить заново' })).toHaveCount(0);

  const question = `Проверка: обрыв дважды ${id}`;
  await say(page, question);
  await expect(page.getByRole('alert')).toContainText('Модель сейчас не отвечает');
  await expect(page.getByText('Ответ прервался')).toBeVisible();
  // Live, CopilotKit's A2UI layers may swallow the words of an attempt that broke right after them
  // (A2UI stays on, decision of the owner 15.11); the history has the words of the last attempt only.

  await page.reload();
  await expect(page.getByRole('alert')).toContainText('APP_MODEL_UNAVAILABLE');
  await expect(page.getByText('Ответ прервался')).toBeVisible();
  await expect(page.getByText('Начинаю отвечать на вопрос')).toHaveCount(1);
  await page.getByRole('button', { name: 'Ответить заново' }).click();
  await expect(page.getByText(AFTER_ANSWER_AGAIN)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Ответ прервался')).toHaveCount(0);
  await expect(page.getByText(question)).toHaveCount(1);

  await page.reload();
  await expect(page.getByText(AFTER_ANSWER_AGAIN)).toBeVisible();
  await expect(page.getByText(question)).toHaveCount(1);
  await expect(page.getByText('Ответ прервался')).toHaveCount(0);
});
