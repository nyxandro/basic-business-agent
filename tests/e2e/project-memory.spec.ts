// The memory of a project (spec, section 8.26): the agent remembers a fact in a conversation of the project,
// the chat says so, and the page of the project shows the entry, changes and removes it.
import { expect, pageAs, say, test } from './helpers.ts';

test('the agent remembers in the project; the page shows, changes and removes the entry', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.getByRole('link', { name: /Тендер/ }).click();
  await page.getByRole('button', { name: 'Новый разговор в проекте' }).click();
  await page.getByRole('menuitem', { name: 'Продажи' }).click();
  await say(page, 'Запомни: подача заявок до 28.11 в 09:00');
  await expect(page.getByRole('button', { name: 'Запомнил в проекте: «подача заявок до 28.11 в 09:00»' })).toBeVisible();
  await expect(page.getByText('Запомнил.')).toBeVisible();

  await page.getByRole('link', { name: /Тендер/ }).click();
  await page.getByRole('button', { name: 'Настройки проекта' }).click();
  const memory = page.getByRole('heading', { name: 'Память проекта' }).locator('xpath=../..');
  await expect(memory.getByText('подача заявок до 28.11 в 09:00')).toBeVisible();
  await expect(memory.getByText(/Ольга через агента · сегодня/)).toBeVisible();

  await memory.getByRole('button', { name: 'Действия с записью 1' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  await memory.getByRole('textbox', { name: 'Запись' }).fill('Подача заявок до 01.12 в 09:00 (перенос)');
  await memory.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Запись сохранена')).toBeVisible();
  await expect(memory.getByText('Подача заявок до 01.12 в 09:00 (перенос)')).toBeVisible();

  await memory.getByRole('button', { name: 'Действия с записью 1' }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await expect(memory.getByText('Подача заявок до 01.12 в 09:00 (перенос)')).toBeHidden();
  await page.getByRole('button', { name: 'Вернуть' }).click();
  await expect(memory.getByText('Подача заявок до 01.12 в 09:00 (перенос)')).toBeVisible();
});
