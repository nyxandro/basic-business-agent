// Criteria 6 and 30 of the spec (section 23): a background task's question waits on «Ждёт
// подтверждения», «Да» runs the action, the result is in the task's conversation marked «новое»;
// on a phone the bell opens the questions as a sheet.
import { expect, openAgent, pageAs, test } from './helpers.ts';

// First, while the stand's only question still waits: the bell opens it on «Ждут решения»
// (docs/specs/[20.11.2026]-notifications.md, F3).
test('on a phone the bell opens the questions as a sheet', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com', { width: 390, height: 844 });
  await page.getByRole('button', { name: /^Уведомления: 1 вопрос ждёт решения/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Уведомления' });
  await expect(sheet.getByRole('radio', { name: 'Ждут решения · 1' })).toHaveAttribute('aria-checked', 'true');
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
  // The result not opened yet: the green tick of its conversation (it replaced «новое», owner 22.11).
  await expect(task.getByRole('img', { name: 'Ответ готов' })).toBeVisible();
  await task.click();
  await expect(page.getByText('Письмо отправлено.')).toBeVisible();
});
