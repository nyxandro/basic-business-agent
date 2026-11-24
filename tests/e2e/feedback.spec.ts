// Samples and tickets (docs/specs/[20.11.2026]-feedback-and-value.md, section 22, step 8; F6, F9, owner 24.11): Игорь
// turns on «Добавление документов в референсы»; Ольга puts the Word document the agent made into the references with the
// heart of its block — it is in the base of «Продажи» at once — sees the heart filled in its viewer and takes it out
// there. A ticket of Ольга goes both ways with Игорь and she closes it.
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_DOCUMENT } from './stand-model.ts';

const ADD = /^Добавить в референсы/;
const IN = /^В референсах/;

test('the heart puts a document of the agent into the references and takes it out, on the block and in the viewer', async ({ browser }) => {
  const igor = await pageAs(browser, 'igor@example.com');
  const samples = igor.getByRole('switch', { name: 'Добавление документов в референсы' });
  const turn = async (on: boolean) => {
    await igor.goto('/admin/interface');
    if ((await samples.getAttribute('aria-checked')) !== String(on)) await samples.click();
    await expect(samples).toHaveAttribute('aria-checked', String(on));
  };
  await turn(true);
  // Off as in a new installation for the scenarios after this one, whatever happens here.
  try {
    const olga = await pageAs(browser, 'olga@example.com');
    await openAgent(olga, 'Продажи');
    await newConversation(olga);
    await say(olga, 'Сделай документ Word с КП');
    await expect(olga.getByText('Готово: документ ниже, его можно скачать.')).toBeVisible();

    await olga.getByRole('button', { name: ADD }).click();
    await expect(olga.getByText('Добавлено в референсы: база «Продажи»')).toBeVisible();
    await expect(olga.getByRole('button', { name: IN })).toHaveAttribute('aria-pressed', 'true');

    await igor.goto('/admin/knowledge');
    await igor.getByRole('button', { name: 'Продажи' }).click();
    await igor.getByRole('button', { name: 'Образцы' }).click();
    await expect(igor.getByText(/Образец · Коммерческое предложение · отметил\(а\) Ольга/)).toBeVisible();

    await olga.getByRole('button', { name: `Открыть ${STAND_DOCUMENT}` }).click();
    const viewer = olga.getByRole('dialog', { name: STAND_DOCUMENT });
    const inBar = viewer.getByRole('button', { name: IN });
    await expect(inBar).toHaveAttribute('aria-pressed', 'true');
    await inBar.click();
    await expect(olga.getByText('Убрано из референсов')).toBeVisible();
    await expect(viewer.getByRole('button', { name: ADD })).toHaveAttribute('aria-pressed', 'false');

    await igor.reload();
    await igor.getByRole('button', { name: 'Продажи' }).click();
    await igor.getByRole('button', { name: 'Образцы' }).click();
    await expect(igor.getByText(/Образец · Коммерческое предложение · отметил\(а\) Ольга/)).toHaveCount(0);
  } finally {
    await turn(false);
  }
});

// A ticket as a conversation (F9, owner 24.11): the employee writes, the support answers, the employee writes again and
// closes it with «Проблема решена» — closed for both sides. Each side sees the other's message without reloading.
test('a ticket goes both ways and «Проблема решена» closes it for both sides', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await olga.goto('/settings/requests');
  await olga.getByRole('button', { name: 'Новое обращение' }).click();
  const form = olga.getByRole('dialog', { name: 'Новое обращение' });
  await form.getByLabel('Тема').fill('Не приходит сводка');
  await form.getByLabel('Описание').fill('Вчера и сегодня сводки не было.');
  await form.getByLabel('Прикрепить файлы').setInputFiles({ name: 'экран.txt', mimeType: 'text/plain', buffer: Buffer.from('снимок') });
  await form.getByRole('button', { name: 'Отправить' }).click();
  await expect(olga.getByRole('heading', { name: 'Не приходит сводка' })).toBeVisible();
  const ticketUrl = olga.url();
  const ticketId = /requests\/(\d+)/.exec(ticketUrl)![1]!;

  const igor = await pageAs(browser, 'igor@example.com');
  await igor.goto('/admin/support');
  await expect(igor.getByRole('link', { name: /^Поддержка, ждут ответа: \d+$/ })).toBeVisible();
  await igor.getByRole('link', { name: new RegExp(`№${ticketId} · Не приходит сводка`) }).click();
  await expect(igor.getByRole('link', { name: 'Скачать экран.txt' })).toBeVisible();
  await igor.getByLabel('Сообщение').fill('Посмотрите в папке «Спам».');
  await igor.getByRole('button', { name: 'Отправить' }).click();
  await expect(igor.getByText('Поддержка ответила')).toBeVisible();

  // The employee's open page shows the answer by itself.
  await expect(olga.getByText('Посмотрите в папке «Спам».')).toBeVisible();
  await olga.getByLabel('Сообщение').fill('В спаме нет.');
  await olga.getByRole('button', { name: 'Отправить' }).click();
  await expect(igor.getByText('В спаме нет.')).toBeVisible();

  await olga.getByRole('button', { name: 'Проблема решена' }).click();
  await olga.getByRole('alertdialog', { name: 'Закрыть обращение?' }).getByRole('button', { name: 'Закрыть' }).click();
  await expect(olga.getByText(/^Вы закрыли обращение: решено/)).toBeVisible();
  await expect(olga.getByLabel('Сообщение')).toHaveCount(0);
  await expect(igor.getByText(/^Закрыто сотрудником: решено/)).toBeVisible();
  await expect(igor.getByLabel('Сообщение')).toHaveCount(0);
});
