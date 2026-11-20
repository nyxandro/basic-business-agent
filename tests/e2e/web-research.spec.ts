// The internet of an agent (spec, section 8.30, #17): the live block of the search while the researcher
// works, one folded line when the answer is ready and after a reload; «Что агенту можно» takes the
// internet and the commands away from the next message.
import { expect, test } from '@playwright/test';
import { newConversation, openAgent, pageAs, say } from './helpers.ts';
import { STAND_NO_WEB, STAND_WEB_ANSWER, STAND_WEB_PAGE, STAND_WEB_QUERY } from './stand-model.ts';

test('the agent searches the internet: the block names the query and the site, then folds into one line', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Найди в интернете цену профнастила С21');
  // While the researcher works, the head of the block says what it does now.
  await expect(page.getByText(`Ищу: «${STAND_WEB_QUERY}»`)).toBeVisible();
  await expect(page.getByText('Читаю example.com…')).toBeVisible();
  await expect(page.getByText(STAND_WEB_ANSWER)).toBeVisible();
  const line = page.getByRole('button', { name: /Поиск в интернете · 1 запрос · 1 источник/ });
  await expect(line).toHaveAttribute('aria-expanded', 'false');

  // After a reload the block is the same: its steps are kept in the result of the call.
  await page.reload();
  await expect(page.getByText(STAND_WEB_ANSWER)).toBeVisible();
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: 'Запросы' })).toContainText(STAND_WEB_QUERY);
  await expect(page.getByRole('region', { name: 'Сайты' }).getByRole('link', { name: STAND_WEB_PAGE.title })).toHaveAttribute('href', STAND_WEB_PAGE.address);
  await page.close();
});

test('without the internet and the commands the agent says so instead of searching or making a document', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/agents/sales/settings');
  const web = admin.getByRole('switch', { name: 'Доступ к сети интернет' });
  const commands = admin.getByRole('switch', { name: 'Доступ к выполнению команд терминала' });
  await expect(web).toHaveAttribute('aria-checked', 'true');
  await expect(commands).toHaveAttribute('aria-checked', 'true');
  await web.click();
  await expect(web).toHaveAttribute('aria-checked', 'false');
  await commands.click();
  await expect(commands).toHaveAttribute('aria-checked', 'false');

  try {
    // Kept on the server, not in the page.
    await admin.reload();
    await expect(web).toHaveAttribute('aria-checked', 'false');
    await expect(commands).toHaveAttribute('aria-checked', 'false');

    const page = await pageAs(browser, 'olga@example.com');
    await openAgent(page, 'Продажи');
    await newConversation(page);
    await say(page, 'Найди в интернете цену профнастила С21');
    await expect(page.getByText(STAND_NO_WEB)).toBeVisible();
    await say(page, 'Сделай документ Word с коммерческим предложением');
    await expect(page.getByText('Команд у меня нет: документ Word сделать не могу.')).toBeVisible();
    await page.close();
  } finally {
    // Other scenarios need the agent as it was.
    for (const ability of [web, commands]) {
      if ((await ability.getAttribute('aria-checked')) === 'false') await ability.click();
      await expect(ability).toHaveAttribute('aria-checked', 'true');
    }
    await admin.close();
  }
});
