// Samples and complaints (docs/specs/[20.11.2026]-feedback-and-value.md, section 22, step 8; F6, owner 24.11): Игорь turns
// on «Добавление документов в референсы»; Ольга puts the Word document the agent made into the references with the heart
// of its block — it is in the base of «Продажи» at once — sees the heart filled in its viewer and takes it out there. She
// complains about the answer — Игорь sees the ticket in «Поддержка», answers and closes it — Ольга reads the answer in
// «Мои обращения».
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

test('a complaint about the answer comes back with the support’s answer', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Сделай документ Word с КП');
  await expect(olga.getByText('Готово: документ ниже, его можно скачать.')).toBeVisible();

  await olga.getByRole('button', { name: 'Пожаловаться' }).last().click();
  const complaint = olga.getByRole('dialog', { name: 'Что было не так?' });
  await expect(complaint.getByText('К жалобе приложится весь этот разговор и его файлы — их увидит поддержка.')).toBeVisible();
  await complaint.getByLabel('Ваш комментарий').fill('В КП нет срока поставки');
  await complaint.getByRole('button', { name: 'Отправить в поддержку' }).click();
  const sent = olga.getByText(/^Жалоба №(\d+) отправлена/);
  await expect(sent).toBeVisible();
  const ticketId = /№(\d+)/.exec((await sent.textContent()) ?? '')![1]!;

  const igor = await pageAs(browser, 'igor@example.com');
  await igor.goto(`/admin/support/${ticketId}`);
  await expect(igor.getByText('В КП нет срока поставки')).toBeVisible();
  await expect(igor.getByText(STAND_DOCUMENT, { exact: true })).toBeVisible();
  await igor.getByLabel('Ответ сотруднику').fill('Добавили срок поставки в образец КП');
  await igor.getByLabel('Состояние').selectOption('resolved');
  await igor.getByRole('button', { name: 'Сохранить' }).click();
  await expect(igor.getByText('Ответ отправлен')).toBeVisible();

  await olga.goto('/settings/requests');
  await expect(olga.getByText('Добавили срок поставки в образец КП')).toBeVisible();
  await expect(olga.getByText('Решена')).toBeVisible();
});
