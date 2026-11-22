// Multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md, section 22, step 8): a rule on the letter of
// the agent → Ольга writes «Зачем» and sends it for approval → Пётр agrees on «Ждёт подтверждения» → the letter goes,
// and the outcome is written in Ольга's conversation.
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';

test('a letter under a rule goes only after the approver agreed, and its outcome comes back to the conversation', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  const petr = await pageAs(browser, 'petr@example.com');
  const petrId = ((await (await petr.request.get('/app/api/me')).json()) as { user: { id: string } }).user.id;
  const rule = await admin.request.post('/app/api/admin/approval-rules', { data: { target: 'mail_send', stages: [[{ kind: 'user', userId: petrId }]], enabled: true } });
  expect(rule.status()).toBe(201);
  const ruleId = ((await rule.json()) as { id: string }).id;
  try {
    const olga = await pageAs(browser, 'olga@example.com');
    await openAgent(olga, 'Продажи');
    await newConversation(olga);
    await say(olga, 'Напиши письмо клиенту о встрече');
    const card = olga.getByRole('group', { name: 'Подтвердите действие' });
    await expect(card.getByText('Нужно согласование: Пётр')).toBeVisible();
    await card.getByLabel('Зачем — увидят согласующие').fill('Клиент ждёт подтверждения встречи сегодня');
    await card.getByRole('button', { name: 'Отправить на согласование' }).click();
    await expect(olga.getByText(/Отправлено на согласование №\d+/)).toBeVisible();

    await petr.goto('/approvals');
    const request = petr.getByRole('article', { name: /^Согласование №\d+ · этап 1 из 1$/ });
    await expect(request.getByText(/Клиент ждёт подтверждения встречи сегодня/)).toBeVisible();
    await request.getByRole('button', { name: 'Согласовать' }).click();
    await expect(request).toHaveCount(0);

    await expect(async () => {
      await olga.reload();
      await expect(olga.getByText(/^Согласование №\d+ · .*согласовано и выполнено/)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  } finally {
    await admin.request.delete(`/app/api/admin/approval-rules/${ruleId}`);
  }
});
