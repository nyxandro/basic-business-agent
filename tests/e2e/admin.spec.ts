// Criteria 2–3 and 31 of the spec (section 23) and the admin panel, in a browser.
import { expect, test } from '@playwright/test';
import { newConversation, openAgent, say, pageAs } from './helpers.ts';

test('a person without rights has no «Админка» and a section sends them back with a notice', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await expect(page.getByRole('link', { name: 'Админка' })).toHaveCount(0);
  await page.goto('/admin/models');
  await expect(page.getByText('Этот раздел вам недоступен. Если он нужен для работы, обратитесь к администратору.')).toBeVisible();
});

test('when the organisation limit runs out, the message does not go to the model and names the date', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/limits');
  const ceiling = admin.getByLabel('Общий потолок организации, ₽ в месяц');
  await ceiling.fill('0');
  await admin.getByRole('button', { name: 'Сохранить' }).click();
  await expect(admin.getByText('Сохранено').first()).toBeVisible();

  try {
    const page = await pageAs(browser, 'olga@example.com');
    await openAgent(page, 'Продажи');
    await newConversation(page);
    await say(page, 'Привет');
    await expect(page.getByText(/Лимит расходов организации на этот месяц исчерпан\. Новый лимит начнётся \d+ \S+/)).toBeVisible();
    await expect(page.getByText(/APP_USAGE_ORG_LIMIT_EXCEEDED/)).toBeVisible();
  } finally {
    await ceiling.fill('');
    await admin.getByRole('button', { name: 'Сохранить' }).click();
    await expect(admin.getByText('Сохранено').first()).toBeVisible();
    await admin.close();
  }
});

test('an invite gives a link that lets the new employee in', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Пригласить' }).click();
  const dialog = page.getByRole('dialog', { name: 'Пригласить сотрудника' });
  await dialog.getByLabel('Почта').fill('anna@example.com');
  await dialog.getByLabel('Имя').fill('Анна');
  await dialog.getByRole('checkbox', { name: 'Бухгалтерия' }).check();
  await dialog.getByRole('button', { name: 'Создать приглашение' }).click();
  await expect(page.getByText('Приглашение создано. Ссылка действует 7 дней — отправьте её сотруднику.')).toBeVisible();
  const link = await page.getByRole('textbox', { name: 'Ссылка' }).inputValue();

  const anna = await browser.newPage();
  await anna.goto(new URL(link).pathname);
  await expect(anna.getByText('Здравствуйте, Анна! Придумайте пароль для входа.')).toBeVisible();
  await anna.getByLabel('Новый пароль').fill('anna-password-1');
  await anna.getByLabel('Повторите пароль').fill('anna-password-1');
  await anna.getByRole('button', { name: 'Сохранить пароль и войти' }).click();
  await expect(anna.getByRole('link', { name: /Помощник/ })).toBeVisible();
  await anna.close();
});
