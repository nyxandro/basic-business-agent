// Criterion 6 of the spec (section 23): a background task's question waits on «Ждёт подтверждения»,
// «Да» runs the action, the result is in the task's conversation marked «новое».
import { expect, test } from '@playwright/test';
import { openAgent, pageAs } from './helpers.ts';

test('the question of a background task is answered on the approvals screen', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await expect(page.getByRole('link', { name: /Ждёт подтверждения\s*1/ })).toBeVisible();
  await page.getByRole('link', { name: /Ждёт подтверждения/ }).click();
  await expect(page.getByText('Продажи · Задача «Утренняя сводка»')).toBeVisible();
  await expect(page.getByText('client@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(page.getByText('Решений от вас не ждут')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ждёт подтверждения', exact: true })).toBeVisible();

  await openAgent(page, 'Продажи');
  const task = page.getByRole('link', { name: /Задача: Утренняя сводка/ });
  await expect(task).toContainText('новое');
  await task.click();
  await expect(page.getByText('Письмо отправлено.')).toBeVisible();
});
