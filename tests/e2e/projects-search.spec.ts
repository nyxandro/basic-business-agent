// Criteria 26–27 of the spec (section 23): projects of conversations and the search over one's own.
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';

test('a conversation started in a project carries the project; the project lists it', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.getByRole('link', { name: /Тендер/ }).click();
  await expect(page.getByRole('heading', { name: 'Тендер' })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки проекта' }).click();
  await expect(page.getByRole('textbox', { name: 'Инструкции для агента' })).toHaveValue('Заказчик — ООО «Пример». Отвечай кратко.');
  await page.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Разговоры' }).click();
  await page.getByRole('button', { name: 'Новый разговор в проекте' }).click();
  await page.getByRole('menuitem', { name: 'Продажи' }).click();
  await expect(page.getByRole('button', { name: /Тендер/, expanded: false })).toBeVisible();
  await say(page, 'Покажи таблицу сделок по арматуре');
  await expect(page.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();

  await page.getByRole('link', { name: /Тендер/ }).click();
  await expect(page.getByRole('link', { name: /арматуре/ })).toBeVisible();
});

test('the search finds one’s own conversation and never someone else’s', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Покажи таблицу: остатки арматуры на складе');
  await expect(olga.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await olga.keyboard.press('Control+k');
  const dialog = olga.getByRole('dialog', { name: 'Поиск' });
  await dialog.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' }).fill('арматур');
  await expect(dialog.getByRole('button', { name: /остатки арматуры/ })).toBeVisible();
  await expect(dialog.getByText(/Найдено: \d+/)).toBeVisible();

  const petr = await pageAs(browser, 'petr@example.com');
  await petr.getByRole('button', { name: 'Поиск' }).click();
  const theirs = petr.getByRole('dialog', { name: 'Поиск' });
  await theirs.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' }).fill('арматур');
  await expect(theirs.getByText('Ничего не нашлось')).toBeVisible();
});

// Section 8.21: documents by name — Latin by a Russian query — in a project opened to a colleague, and
// conversations by another form of a word and with a typo.
test('a colleague finds a document of a shared project by Russian words, opens its window and downloads it', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await olga.getByRole('button', { name: 'Новый проект' }).click();
  const create = olga.getByRole('dialog', { name: 'Новый проект' });
  await create.getByRole('textbox', { name: 'Название проекта' }).fill('Тендер ЖК Северный');
  await create.getByRole('radio', { name: 'Выбранным' }).click();
  await create.getByRole('textbox', { name: 'Имя, фамилия или почта' }).fill('пётр');
  await create.getByRole('button', { name: /Пётр/ }).click();
  await create.getByRole('button', { name: 'Создать проект' }).click();
  await expect(olga.getByRole('heading', { name: 'Тендер ЖК Северный' })).toBeVisible();
  await olga.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Файлы' }).click();
  await olga.getByLabel('Загрузить файл', { exact: true }).setInputFiles({ name: 'KP_Yelka_v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  await expect(olga.getByRole('button', { name: 'KP_Yelka_v2.pdf', exact: true })).toBeVisible();

  const petr = await pageAs(browser, 'petr@example.com');
  await petr.keyboard.press('Control+k');
  const search = petr.getByRole('dialog', { name: 'Поиск' });
  const field = search.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' });
  await field.fill('кп ёлка');
  await search.getByRole('button', { name: /KP_Yelka_v2\.pdf.*Тендер ЖК Северный/ }).click();
  const file = petr.getByRole('dialog', { name: 'KP_Yelka_v2.pdf' });
  await expect(file.getByRole('button', { name: 'Посмотреть' })).toBeVisible();
  const download = petr.waitForEvent('download');
  await file.getByRole('link', { name: 'Скачать' }).click();
  expect((await download).suggestedFilename()).toBe('KP_Yelka_v2.pdf');
  await file.getByRole('button', { name: 'Закрыть' }).click();
  await expect(file).toHaveCount(0);

  // Ольга closes the project: Пётр does not find its document any more.
  await olga.getByRole('button', { name: 'Настроить доступ' }).click();
  const access = olga.getByRole('dialog', { name: 'Кому открыт проект' });
  await access.getByRole('radio', { name: 'Только я' }).click();
  await access.getByRole('button', { name: 'Сохранить' }).click();
  await expect(olga.getByText('Только вы')).toBeVisible();
  await field.fill('');
  await field.fill('кп ёлка');
  await expect(search.getByText('Ничего не нашлось')).toBeVisible();
});

test('a conversation is found by another form of a word and with a typo', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Покажи таблицу: договор поставки щебня');
  await expect(olga.getByRole('cell', { name: 'Поставка бетона' })).toBeVisible();
  await olga.keyboard.press('Control+k');
  const search = olga.getByRole('dialog', { name: 'Поиск' });
  const field = search.getByRole('textbox', { name: 'Поиск по разговорам, проектам и файлам' });
  for (const query of ['договору щебня', 'дговор щебня', 'dogovor']) {
    await field.fill(query);
    await expect(search.getByRole('button', { name: /договор поставки щебня/ })).toBeVisible();
  }
});
