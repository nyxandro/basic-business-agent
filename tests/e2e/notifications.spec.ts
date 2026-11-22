// Notifications (docs/specs/[20.11.2026]-notifications.md, section 23): a question of a background task reaches the
// person's phone the moment it is asked; a question of a conversation marks its row in «Недавние» at once, waits under
// the bell on «Ждут решения» and leads to its card «Да» in the conversation.
import type { ReceivedPush } from '../../core/notifications/fake-push.ts';
import { expect, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_PUSH_RECEIVED } from './stand-push.ts';

const received = async (): Promise<ReceivedPush[]> => (await (await fetch(STAND_PUSH_RECEIVED)).json()) as ReceivedPush[];

test('a question of a background task reached the phone at once, leading to itself', async () => {
  await expect.poll(async () => (await received()).map((r) => r.payload.title)).toContain('Ждёт вашего решения');
  const push = (await received()).find((r) => r.payload.kind === 'approval_waiting')!;
  expect(push.payload.body).toBe('Утренняя сводка · Отправить письмо клиенту');
  expect(push.payload.link).toMatch(/^\/approvals\?question=[0-9a-f-]{36}$/);
  expect(push.ttl).toBe(12 * 3600);
});

test('a question of a conversation waits under the bell and leads to its card', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await say(page, 'Напиши письмо клиенту о встрече');
  await expect(page.getByRole('button', { name: 'Да, выполнить' })).toBeVisible();
  // Its row in «Недавние» shows the amber mark at once (the instant channel, owner 22.11).
  await expect(page.getByRole('link', { name: /Ждёт вашего решения/ }).first()).toBeVisible();

  await page.getByRole('button', { name: /^Уведомления:.*вопрос/ }).click();
  const panel = page.getByRole('dialog', { name: 'Уведомления' });
  await panel.getByRole('radio', { name: /^Ждут решения/ }).click();
  const card = panel.getByRole('article').filter({ hasText: /^Из разговора/ });
  await expect(card).toContainText('Отправить письмо клиенту');
  await card.getByRole('link', { name: 'Открыть разговор' }).click();
  await expect(panel).toHaveCount(0);

  // The card «Да» of that conversation; «Нет» leaves nothing waiting for the scenarios after.
  await page.getByRole('button', { name: 'Нет' }).click();
  await expect(page.getByText('Действие отменено')).toBeVisible();
});

test('«Настройки → Уведомления» tells the state of this browser', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Уведомления', level: 1 })).toBeVisible();
  // The stand is opened at http://localhost: a secure address, so the browser can turn notifications on.
  await expect(page.getByText(/(Выключены|Включены) в этом браузере|не умеет уведомления|запрещены в настройках браузера/)).toBeVisible();
  await expect(page.getByText('С 21:00 до 8:00 — не беспокоим', { exact: false })).toBeVisible();
});
