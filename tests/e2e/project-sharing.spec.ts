// Criteria 34–46 of the spec (section 23; section 8.20): a project opened to a colleague, closed and
// opened again, archived; a removed file comes back from the project's trash.
import { expect, pageAs, test } from './helpers.ts';

test('a project opened to a colleague, closed and opened again, archived', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await olga.getByRole('button', { name: 'Новый проект' }).click();
  const create = olga.getByRole('dialog', { name: 'Новый проект' });
  await create.getByRole('textbox', { name: 'Название проекта' }).fill('Совместный тендер');
  await create.getByRole('radio', { name: 'Выбранным' }).click();
  await create.getByRole('textbox', { name: 'Имя, фамилия или почта' }).fill('пётр');
  await create.getByRole('button', { name: /Пётр/ }).click();
  await create.getByRole('button', { name: 'Создать проект' }).click();
  await expect(olga.getByRole('heading', { name: 'Совместный тендер' })).toBeVisible();
  await expect(olga.getByText('Открыт: Пётр')).toBeVisible();

  // Пётр sees it marked «новое», opens it and starts his conversation in it.
  const petr = await pageAs(browser, 'petr@example.com');
  const link = petr.getByRole('link', { name: /Совместный тендер/ });
  await expect(link).toContainText('новое');
  await link.click();
  await expect(petr.getByText('Открыл(а): Ольга')).toBeVisible();
  await expect(petr.getByRole('button', { name: 'В архив' })).toHaveCount(0);
  // The instructions are in «Настройки проекта»: a colleague reads them, only the creator changes them.
  await petr.getByRole('button', { name: 'Настройки проекта' }).click();
  await expect(petr.getByText('Инструкции меняет создатель проекта.')).toBeVisible();
  await petr.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Разговоры' }).click();
  await petr.getByRole('button', { name: 'Новый разговор в проекте' }).click();
  await expect(petr.getByRole('button', { name: /Совместный тендер/, expanded: false })).toBeVisible();
  const conversation = petr.url();

  // Ольга closes it: Пётр's conversation says so; the project is gone from his panel.
  await olga.getByRole('button', { name: 'Настроить доступ' }).click();
  const access = olga.getByRole('dialog', { name: 'Кому открыт проект' });
  await access.getByRole('radio', { name: 'Только я' }).click();
  await access.getByRole('button', { name: 'Сохранить' }).click();
  await expect(olga.getByText('Только вы')).toBeVisible();
  await petr.goto(conversation);
  await expect(petr.getByText(/Проект «Совместный тендер» вам больше недоступен: доступ закрыт\..*попросите доступ у создателя: Ольга\./)).toBeVisible();
  await expect(petr.getByRole('link', { name: /Совместный тендер/ })).toHaveCount(0);

  // Opened again: the conversation is in the project again, no notice.
  await olga.getByRole('button', { name: 'Настроить доступ' }).click();
  await access.getByRole('radio', { name: 'Выбранным' }).click();
  await access.getByRole('textbox', { name: 'Имя, фамилия или почта' }).fill('пётр');
  await access.getByRole('button', { name: /Пётр/ }).click();
  await access.getByRole('button', { name: 'Сохранить' }).click();
  await expect(olga.getByText('Открыт: Пётр')).toBeVisible();
  await petr.goto(conversation);
  await expect(petr.getByRole('button', { name: /Совместный тендер/, expanded: false })).toBeVisible();
  await expect(petr.getByText(/вам больше недоступен/)).toHaveCount(0);

  // Archived: gone for both, «Архив · 1» for Ольга; Пётр's conversation says why.
  await olga.getByRole('button', { name: 'В архив' }).click();
  await expect(olga.getByText('Проект «Совместный тендер» в архиве')).toBeVisible();
  await expect(olga.getByRole('link', { name: /Архив · 1/ })).toBeVisible();
  await petr.goto(conversation);
  await expect(petr.getByText('Проект «Совместный тендер» в архиве. Разговор остался у вас, но агент больше не видит файлы и инструкции проекта.')).toBeVisible();
  await olga.getByRole('link', { name: /Архив · 1/ }).click();
  await expect(olga.getByRole('heading', { name: 'Архив проектов' })).toBeVisible();
  await expect(olga.getByRole('button', { name: 'Удалить навсегда' })).toBeDisabled();
  await olga.getByRole('listitem').filter({ hasText: 'Совместный тендер' }).getByRole('button', { name: 'Вернуть' }).click();
  await expect(olga.getByText('В архиве пусто.', { exact: false })).toBeVisible();
});

test('a removed file of a project lies in its trash and comes back', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await olga.getByRole('link', { name: /^Тендер/ }).click();
  await expect(olga.getByRole('heading', { name: 'Тендер' })).toBeVisible();
  await olga.getByRole('navigation', { name: 'Разделы проекта' }).getByRole('link', { name: 'Файлы' }).click();
  await olga.getByLabel('Загрузить файл', { exact: true }).setInputFiles({ name: 'смета.txt', mimeType: 'text/plain', buffer: Buffer.from('СМЕТА') });
  await expect(olga.getByRole('button', { name: 'смета.txt', exact: true })).toBeVisible();
  await olga.getByRole('button', { name: 'Удалить смета.txt' }).click();
  await expect(olga.getByText('Файл «смета.txt» в корзине')).toBeVisible();
  await expect(olga.getByRole('button', { name: 'смета.txt', exact: true })).toHaveCount(0);
  await olga.getByRole('button', { name: 'Корзина · 1' }).click();
  const trash = olga.getByRole('dialog', { name: 'Корзина проекта' });
  await expect(trash.getByText('Удалил(а) Ольга', { exact: false })).toBeVisible();
  await trash.getByRole('button', { name: 'Вернуть' }).click();
  await expect(trash.getByText('Корзина пуста.', { exact: false })).toBeVisible();
  await olga.keyboard.press('Escape');
  await expect(olga.getByRole('button', { name: 'смета.txt', exact: true })).toBeVisible();
});
