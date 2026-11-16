// Criteria 26–27 of the spec (section 23): projects of conversations and the search over one's own.
import { expect, test } from '@playwright/test';
import { newConversation, openAgent, pageAs, say } from './helpers.ts';

test('a conversation started in a project carries the project; the project lists it', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.getByRole('link', { name: /Тендер/ }).click();
  await expect(page.getByRole('heading', { name: 'Тендер' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Инструкции для агента' })).toHaveValue('Заказчик — ООО «Пример». Отвечай кратко.');
  await page.getByRole('button', { name: 'Новый разговор в проекте' }).click();
  await page.getByRole('menuitem', { name: 'Продажи' }).click();
  await expect(page.getByRole('button', { name: /Тендер/, expanded: false })).toBeVisible();
  await say(page, 'Покажи таблицу сделок по арматуре');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();

  await page.getByRole('link', { name: /Тендер/ }).click();
  await expect(page.getByRole('link', { name: /арматуре/ })).toBeVisible();
});

test('the search finds one’s own conversation and never someone else’s', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Покажи таблицу: остатки арматуры на складе');
  await expect(olga.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await olga.keyboard.press('Control+k');
  const dialog = olga.getByRole('dialog', { name: 'Поиск' });
  await dialog.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' }).fill('арматур');
  await expect(dialog.getByRole('button', { name: /остатки арматуры/ })).toBeVisible();
  await expect(dialog.getByText(/Найдено: \d+/)).toBeVisible();

  const petr = await pageAs(browser, 'petr@example.com');
  await petr.getByRole('button', { name: 'Поиск' }).click();
  const theirs = petr.getByRole('dialog', { name: 'Поиск' });
  await theirs.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' }).fill('арматур');
  await expect(theirs.getByText('Ничего не нашлось')).toBeVisible();
});
