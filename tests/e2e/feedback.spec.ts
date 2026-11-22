// Complaints and samples (docs/specs/[20.11.2026]-feedback-and-value.md, section 22, step 8): Ольга marks the Word document
// the agent made as a good sample — it is in the base of «Продажи» at once; she complains about the answer — Игорь sees the
// ticket in «Поддержка», answers and closes it — Ольга reads the answer in «Мои обращения».
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_DOCUMENT } from './stand-model.ts';

test('a good document becomes a sample, and a complaint about the answer comes back with the support’s answer', async ({ browser }) => {
  const olga = await pageAs(browser, 'olga@example.com');
  await openAgent(olga, 'Продажи');
  await newConversation(olga);
  await say(olga, 'Сделай документ Word с КП');
  await expect(olga.getByText('Готово: документ ниже, его можно скачать.')).toBeVisible();

  await olga.getByRole('button', { name: `Хороший образец: ${STAND_DOCUMENT}` }).click();
  const sample = olga.getByRole('dialog', { name: 'Сохранить как образец' });
  await expect(sample.getByLabel('Вид документа')).toHaveValue('Коммерческое предложение');
  await expect(sample.getByText('Куда попадёт: база «Продажи»')).toBeVisible();
  await sample.getByRole('button', { name: 'Сохранить' }).click();
  await expect(olga.getByText('Уже сохранён как образец')).toBeVisible();

  await olga.getByRole('button', { name: 'Пожаловаться' }).last().click();
  const complaint = olga.getByRole('dialog', { name: 'Что было не так?' });
  await expect(complaint.getByText('К жалобе приложится весь этот разговор и его файлы — их увидит поддержка.')).toBeVisible();
  await complaint.getByLabel('Ваш комментарий').fill('В КП нет срока поставки');
  await complaint.getByRole('button', { name: 'Отправить в поддержку' }).click();
  const sent = olga.getByText(/^Жалоба №(\d+) отправлена/);
  await expect(sent).toBeVisible();
  const ticketId = /№(\d+)/.exec((await sent.textContent()) ?? '')![1]!;

  const igor = await pageAs(browser, 'igor@example.com');
  await igor.goto('/admin/knowledge');
  await igor.getByRole('button', { name: 'Продажи' }).click();
  await igor.getByRole('button', { name: 'Образцы' }).click();
  await expect(igor.getByText(/Образец · Коммерческое предложение · отметил\(а\) Ольга/)).toBeVisible();

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
