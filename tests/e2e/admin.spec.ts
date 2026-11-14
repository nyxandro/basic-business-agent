// Criteria 2–3 of the spec (section 23) and the admin panel of step 19, in a browser.
import { expect, test } from '@playwright/test';
import { newConversation, openAgent, say, pageAs } from './helpers.ts';

test('a section without the right sends the person to the start page with a notice', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.goto('/admin/users');
  await expect(page.getByText('Этот раздел вам недоступен. Если он нужен для работы, обратитесь к администратору.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Администрирование' })).toHaveCount(0);
});

test('when the organisation limit runs out, the message does not go to the model and names the date', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/limits');
  const ceiling = admin.getByLabel(/Общий потолок организации/);
  await ceiling.fill('0');
  await admin.getByRole('button', { name: 'Сохранить' }).first().click();
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
    await admin.getByRole('button', { name: 'Сохранить' }).first().click();
    await expect(admin.getByText('Сохранено').first()).toBeVisible();
    await admin.close();
  }
});

test('an invite gives a link that lets the new employee in', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/users');
  await page.getByLabel('Почта').fill('anna@example.com');
  await page.getByLabel('Имя').fill('Анна');
  await page.getByRole('checkbox', { name: 'Бухгалтерия' }).check();
  await page.getByRole('button', { name: 'Создать приглашение' }).click();
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
