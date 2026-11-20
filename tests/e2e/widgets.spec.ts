// Widgets in the chat (spec, section 8.31), in a browser: a screen works without the agent, its buttons and forms send
// the person's message with the values, it stays after a reload, and the switch of the agent takes widgets away.
import { expect, test, type Page } from '@playwright/test';
import { newConversation, openAgent, pageAs, say } from './helpers.ts';

// The person's message the press of a widget sent, as the chat shows it.
const sentByWidget = (page: Page, text: RegExp) => page.getByText(text).first();

// A press is sent once the answer is over (while it goes, the widget says to press again).
const answered = (page: Page) => expect(page.getByRole('button', { name: 'Остановить ответ' })).toHaveCount(0);

test('a calculator recalculates in the browser; its button sends the message with the values; a reload keeps it', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Нужен калькулятор КП');
  await expect(page.getByText('43 500 ₽')).toBeVisible();
  await expect(page.getByText('Готово, показал выше.')).toBeVisible();
  await answered(page);

  const slider = page.getByRole('slider', { name: 'Сотрудников' });
  await slider.focus();
  for (let i = 0; i < 5; i++) await slider.press('ArrowRight');
  await expect(page.getByText('58 000 ₽')).toBeVisible();

  await page.getByRole('button', { name: 'Оформить КП' }).click();
  await expect(sentByWidget(page, /Готовь КП/)).toBeVisible();
  await expect(page.getByText(/Вы написали: «готовь кп/)).toBeVisible();
  await expect(page.getByText(/seats: 20/).first()).toBeVisible();

  // The screen is drawn again from the saved call: with the values it was drawn with.
  await page.reload();
  await expect(page.getByText('43 500 ₽')).toBeVisible();
});

test('a choice and a form send what the person picked and filled', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Дай выбор, кому писать');
  await expect(page.getByText('Готово, показал выше.')).toBeVisible();
  await answered(page);
  await page.getByRole('button', { name: 'ИП Тестов' }).click();
  await expect(page.getByText(/Вы написали: «пишем первым: ип тестов/)).toBeVisible();
  // As a choice of the chat (owner 16.11, 20.11): the pressed one is marked, the other is inactive — after a reload too.
  await expect(page.getByRole('button', { name: /^ИП Тестов\s*, выбрано$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ООО «Пример»' })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: /^ИП Тестов\s*, выбрано$/ })).toBeVisible();

  await say(page, 'Нужна форма заявки');
  await expect(page.getByText('Готово, показал выше.').nth(1)).toBeVisible();
  await answered(page);
  const form = page.locator('[data-generative-ui-surface]').filter({ hasText: 'Новая заявка' });
  await form.getByRole('textbox', { name: 'Клиент' }).fill('ООО Сибирь');
  await form.getByRole('radio', { name: 'Переговоры' }).click();
  await form.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText(/client: ООО Сибирь/).first()).toBeVisible();
  await expect(page.getByText(/stage: Переговоры/).first()).toBeVisible();
});

test('with «Виджеты в чате» switched off the agent answers in words', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/agents/assistant/settings');
  const widgets = admin.getByRole('switch', { name: 'Виджеты в чате' });
  await expect(widgets).toHaveAttribute('aria-checked', 'true');
  await widgets.click();
  await expect(widgets).toHaveAttribute('aria-checked', 'false');

  try {
    const page = await pageAs(browser, 'olga@example.com');
    await openAgent(page, 'Помощник');
    await newConversation(page);
    await say(page, 'Покажи таблицу сделок');
    await expect(page.getByText('Виджетов у меня нет, отвечаю текстом')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toHaveCount(0);
    await page.close();
  } finally {
    await widgets.click();
    await expect(widgets).toHaveAttribute('aria-checked', 'true');
    await admin.close();
  }
});
