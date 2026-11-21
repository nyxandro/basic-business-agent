// Own MCP connections in a browser (docs/specs/[20.11.2026]-mcp-connections.md, step 10): the admin adds a system
// without a developer, an employee turns it on for herself, the agent reads without «Да» and changes after «Да».
// The systems of the stand are in stand-mcp.ts.
import type { Page } from '@playwright/test';
import { STAND_MCP } from './stand-mcp.ts';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';

// Two people, a check of the system and a conversation in one scenario.
test.describe.configure({ timeout: 180_000 });

// The admin's window «Сервер MCP» from «Подключения»: the title and the address, then «Далее».
async function addServer(admin: Page, title: string) {
  await admin.goto('/admin/connections');
  await admin.getByRole('button', { name: 'Добавить сервер MCP' }).click();
  await admin.getByRole('dialog', { name: 'Сервер MCP' }).getByLabel('Название').fill(title);
  // Once saved, the window is named after the server: it is the only window on the page.
  return admin.getByRole('dialog');
}

test('a system with a key in its address: Ольга connects with her key, reads without «Да» and changes after it', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  const dialog = await addServer(admin, 'МойСклад');
  await dialog.getByLabel('Адрес сервера').fill(STAND_MCP.keyed);
  await dialog.getByRole('button', { name: 'Далее' }).click();
  // An address with {{…}} asks for the fields first: it answers only with a value.
  await expect(dialog.getByRole('radio', { name: 'Личный ключ сотрудника — каждый введёт свой' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Сохранить черновик' }).click();
  await dialog.getByLabel('Ключ API — ваш, только для проверки').fill('igor-key');
  await dialog.getByRole('button', { name: 'Проверить своим доступом' }).click();

  const search = dialog.getByRole('listitem').filter({ hasText: 'deals_search' });
  await search.getByRole('switch').click();
  await search.getByRole('checkbox', { name: 'Только чтение — без «Да»' }).check();
  const create = dialog.getByRole('listitem').filter({ hasText: 'deal_create' });
  await create.getByRole('switch').click();
  await create.getByPlaceholder('Название для сотрудников').fill('Новая сделка');
  await expect(dialog.getByText(/Включённые действия добавляют к каждому запросу агента около \d+ токенов/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Включить' }).click();
  await expect(dialog.getByText('Работает')).toBeVisible();
  await admin.close();

  const olga = await pageAs(browser, 'olga@example.com');
  await olga.goto('/settings/connections');
  const keyForm = olga.locator('form').filter({ has: olga.getByLabel('Ключ API') });
  await keyForm.getByLabel('Ключ API').fill('olga-key');
  await keyForm.getByRole('button', { name: 'Подключить' }).click();
  await expect(olga.getByText('Сохранено, проверится при первом действии')).toBeVisible();

  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Найди сделки в МойСклад');
  await expect(olga.getByText('Система ответила: {"deals":12}')).toBeVisible();
  await expect(olga.getByText('Подтвердите действие')).toHaveCount(0);

  await say(olga, 'Создай сделку в МойСклад');
  await expect(olga.getByText('Подтвердите действие')).toBeVisible();
  await expect(olga.getByText('Новая сделка').first()).toBeVisible();
  await olga.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(olga.getByText('Система ответила: {"created":"Поставка"}')).toBeVisible();
});

test('a system with a sign-in on its site: the admin checks it with his account, Ольга connects with hers', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  const dialog = await addServer(admin, 'Битрикс24');
  await dialog.getByLabel('Адрес сервера').fill(STAND_MCP.portal);
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await expect(dialog.getByText('Сервер просит войти через свой сайт.')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Вход через сайт системы — каждый сотрудник войдёт своим аккаунтом' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Сохранить черновик' }).click();
  // The site of the system signs in at once and sends the browser back to this window.
  await dialog.getByRole('button', { name: 'Проверить своим доступом' }).click();
  const back = admin.getByRole('dialog', { name: 'Битрикс24' });
  await expect(back).toBeVisible();
  const search = back.getByRole('listitem').filter({ hasText: 'deals_search' });
  await search.getByRole('switch').click();
  await search.getByRole('checkbox', { name: 'Только чтение — без «Да»' }).check();
  await back.getByRole('button', { name: 'Включить' }).click();
  await expect(back.getByText('Работает')).toBeVisible();
  await admin.close();

  const olga = await pageAs(browser, 'olga@example.com');
  await olga.goto('/settings/connections');
  const card = olga.locator('form, div').filter({ hasText: /^Битрикс24/ }).filter({ has: olga.getByRole('button', { name: 'Подключить' }) }).last();
  await card.getByRole('button', { name: 'Подключить' }).click();
  await expect(olga.getByText('«Битрикс24» подключена.')).toBeVisible();
});

test('a program server through mcp-runner: Ольга turns it on and the agent asks it', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  const dialog = await addServer(admin, '1С');
  await dialog.getByRole('radio', { name: 'Программа (npx или uvx)' }).click();
  await dialog.getByLabel('Пакет с точной версией').fill(STAND_MCP.program);
  await dialog.getByRole('button', { name: 'Сохранить черновик' }).click();
  await dialog.getByRole('button', { name: 'Проверить своим доступом' }).click();
  const echo = dialog.getByRole('listitem').filter({ hasText: 'echo' });
  await echo.getByRole('switch').click();
  await echo.getByRole('checkbox', { name: 'Только чтение — без «Да»' }).check();
  await dialog.getByRole('button', { name: 'Включить' }).click();
  await expect(dialog.getByText('Работает')).toBeVisible();
  await admin.close();

  const olga = await pageAs(browser, 'olga@example.com');
  await olga.goto('/settings/connections');
  await olga.getByRole('switch', { name: 'Использовать «1С»' }).click();
  await expect(olga.getByRole('switch', { name: 'Использовать «1С»' })).toBeChecked();
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Спроси в 1С остатки');
  await expect(olga.getByText('Система ответила: остатки на складе')).toBeVisible();
  await expect(olga.getByRole('button', { name: /1С · echo/ })).toBeVisible();
});
