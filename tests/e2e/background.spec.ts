// Criteria 6 and 30 of the spec (section 23): a background task's question waits on «Ждёт
// подтверждения», «Да» runs the action, the result is in the task's conversation marked «новое»;
// on a phone the bell opens the questions as a sheet.
import { expect, test } from '@playwright/test';
import { openAgent, pageAs } from './helpers.ts';

// First, while the stand's only question still waits: the bell is there only when there is
// something to answer.
test('on a phone the bell opens the questions as a sheet', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com', { width: 390, height: 844 });
  await page.getByRole('button', { name: /^Ждёт подтверждения/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Ждёт подтверждения' });
  await expect(sheet.getByText('Вопросы от фоновых задач агентов')).toBeVisible();
  await expect(sheet.getByRole('article').filter({ hasText: 'Утренняя сводка' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await expect(sheet).toHaveCount(0);
});

test('the question of a background task is answered on the approvals screen', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await expect(page.getByRole('link', { name: /Ждёт подтверждения.*1/ })).toBeVisible();
  await page.getByRole('link', { name: /Ждёт подтверждения/ }).click();
  const card = page.getByRole('article').filter({ hasText: 'Утренняя сводка' });
  await expect(card).toContainText('· агент Продажи');
  await expect(card).toContainText('client@example.com');
  await card.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(card.getByText('Выполнено')).toBeVisible();

  await openAgent(page, 'Продажи');
  const task = page.getByRole('link', { name: /Задача: Утренняя сводка/ });
  await expect(task).toContainText('новое');
  await task.click();
  await expect(page.getByText('Письмо отправлено.')).toBeVisible();
});
