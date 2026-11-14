// The admin panel of stage 2 in a browser (criteria 21, 25, 29): «Нейросеть», «Скиллы», «Режимы
// работы», on a computer and on a phone.
import { expect, test } from '@playwright/test';
import { pageAs } from './helpers.ts';

test('«Нейросеть» shows the gateway, the catalog and the parameters', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/models');
  await expect(page.getByText(/Шлюз работает|Шлюз применяет изменения/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Каталог моделей' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Основная модель' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Модель распознавания речи' })).toHaveValue('');
});

test('«Скиллы» lists the uploaded skill for the whole organisation with its switch', async ({ browser }) => {
  const page = await pageAs(browser, 'igor@example.com');
  await page.goto('/admin/skills');
  await expect(page.getByText('read-documents')).toBeVisible();
  await expect(page.getByText('Вся организация')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Чтение документов' })).toHaveAttribute('aria-checked', 'true');
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
