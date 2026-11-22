// The admin panel of stage 2 in a browser (criteria 21, 25, 29): «Нейросеть», «Скиллы», «Режимы
// работы», on a computer and on a phone.
import { expect, pageAs, test } from './helpers.ts';

test('«Нейросеть» shows the gateway, the catalog and the parameters', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/models');
  await expect(page.getByText(/Шлюз работает|Шлюз применяет изменения/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Каталог моделей' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Основная модель' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Модель распознавания речи' })).toHaveValue('');
});

test('«Пул аккаунтов подписки» shows the states and connects an account by the code on OpenAI’s page', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/models');
  const pool = page.getByRole('list', { name: 'Аккаунты подписки' });
  const account = (email: string) => pool.getByRole('listitem').filter({ hasText: email });
  await expect(account('sales.gpt@example.com')).toContainText('Работает · последний успешный запрос');
  await expect(account('office.gpt@example.com')).toContainText('Охлаждение — ошибка 429, вернётся в');
  await expect(account('reserve.gpt@example.com')).toContainText('Нет запросов');
  // The tile «2 из 3 активны» is gone (owner's list 16.11): the states are in the rows of the pool.

  await page.getByRole('button', { name: 'Добавить аккаунт' }).click();
  const dialog = page.getByRole('dialog', { name: 'Подключить аккаунт ChatGPT' });
  await expect(dialog.getByRole('timer')).toHaveText(/осталось 1[45]:\d\d/);
  const code = await dialog.getByLabel('Код входа').inputValue();
  const [site] = await Promise.all([page.context().waitForEvent('page'), dialog.getByRole('link', { name: 'Открыть сайт OpenAI' }).click()]);
  await site.getByLabel('Код').fill(code);
  await site.getByLabel('Почта аккаунта').fill('new.gpt@example.com');
  await site.getByRole('button', { name: 'Продолжить' }).click();
  await expect(site.getByText('Вход выполнен')).toBeVisible();
  await site.close();
  await expect(page.getByText('Аккаунт подключён: new.gpt@example.com')).toBeVisible();
  await expect(account('new.gpt@example.com')).toContainText('Нет запросов');
});

test('«Скиллы» lists the system skills of documents without a switch, then the uploaded skill with its switch', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/skills');
  // System skills of the core (spec, section 8.18): built in, always on, nothing to change.
  // …and the letterhead of the organisation (docs/specs/[20.11.2026]-org-letterhead.md).
  for (const title of ['Документы Word', 'Презентации PowerPoint', 'Таблицы Excel', 'PDF', 'Бланк организации']) await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText('Системный')).toHaveCount(5);
  await expect(page.getByRole('switch')).toHaveCount(1);
  await expect(page.getByText('note-taking')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Заметки сотрудника' })).toHaveAttribute('aria-checked', 'true');
});

test('«Режимы работы» shows the task of the department with its last fire and breakdown', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/modes');
  const row = page.getByRole('row').filter({ hasText: 'Утренняя сводка' });
  await expect(row).toContainText('Отделы: Продажи');
  await expect(row.getByRole('switch', { name: 'Утренняя сводка' })).toHaveAttribute('aria-checked', 'true');
  await row.getByRole('button', { name: /из 1|не запускалась/ }).click();
  await expect(page.getByRole('dialog', { name: 'Разбивка: Утренняя сводка' })).toContainText('Ольга');
});

test('on a phone the sections of the admin panel are chips', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com', { width: 390, height: 844 });
  await page.goto('/admin/users');
  const chips = page.getByRole('navigation', { name: 'Разделы админки' });
  await expect(chips.getByRole('link', { name: 'Сотрудники' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Вернуться в чат' })).toBeVisible();
});
