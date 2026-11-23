// The name of a conversation (spec, section 8.16): named once its task is clear, renamed by hand from
// its three dots in «Недавние». The stand's model names a conversation by the person's last message
// and says «-» to a greeting (stand-model.ts).
import type { Page } from '@playwright/test';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';

// The open conversation in «Недавние»: its link carries the id of the thread.
function ownRow(page: Page) {
  const threadId = new URL(page.url()).searchParams.get('thread');
  if (!threadId) throw new Error(`no conversation is open at ${page.url()}`);
  return page.locator(`a[href$="thread=${threadId}"]`);
}

test('a conversation is named once its task is clear and renamed by hand from its three dots', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);

  await say(page, 'Привет!');
  await expect(page.getByText(/Вы написали: «привет!/)).toBeVisible();
  await expect(ownRow(page)).toHaveText('Привет!');

  await say(page, 'Покажи график выручки');
  await expect(page.getByRole('img', { name: /Выручка по месяцам/ })).toBeVisible();
  await expect(ownRow(page)).toHaveText('Покажи график выручки');

  await ownRow(page).hover();
  await page.getByRole('button', { name: 'Действия с разговором «Покажи график выручки»' }).click();
  await page.getByRole('menuitem', { name: 'Переименовать' }).click();
  const field = page.getByRole('textbox', { name: 'Название разговора' });
  await expect(field).toHaveValue('Покажи график выручки');
  await field.fill('Выручка за осень');
  await field.press('Enter');
  await expect(ownRow(page)).toHaveText('Выручка за осень');

  // The name stays after a reload and after the next message, whatever it is about.
  await page.reload();
  await expect(ownRow(page)).toHaveText('Выручка за осень');
  await say(page, 'А теперь таблицу сделок');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await expect(ownRow(page)).toHaveText('Выручка за осень');
});
