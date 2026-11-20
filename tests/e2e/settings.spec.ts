// The employee's settings in a browser: memory with a question before forgetting, spend.
import { expect, pageAs, test } from './helpers.ts';

test('memory is added by hand and forgotten only after the question', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.goto('/settings/memory');
  await page.getByRole('button', { name: 'Добавить запись' }).click();
  await page.getByRole('textbox', { name: 'Запись' }).fill('Ведёт только юрлиц');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Запись добавлена')).toBeVisible();
  await expect(page.getByText('Ведёт только юрлиц')).toBeVisible();
  await expect(page.getByText('Вы · сегодня')).toBeVisible();

  await page.getByRole('button', { name: 'Забыть всё' }).click();
  await page.getByRole('alertdialog', { name: 'Забыть всё?' }).getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByText('Ведёт только юрлиц')).toBeVisible();

  await page.getByRole('button', { name: 'Забыть всё' }).click();
  await page.getByRole('alertdialog', { name: 'Забыть всё?' }).getByRole('button', { name: 'Забыть всё' }).click();
  await expect(page.getByText('Память очищена')).toBeVisible();
  await expect(page.getByText('Агенты пока ничего о вас не запомнили')).toBeVisible();
});

test('my spend is shown in plain words', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.goto('/settings/usage');
  await expect(page.getByText(/Израсходовано|В этом месяце расходов пока нет/)).toBeVisible();
});
