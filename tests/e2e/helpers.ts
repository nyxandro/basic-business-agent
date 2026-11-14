// Steps shared by the end-to-end scenarios.
import { expect, type Browser, type Page } from '@playwright/test';

// TEST_PASSWORD of core/server/test-app.ts: the stand creates its people with it.
export const STAND_PASSWORD = 'correct-horse-battery';
export const STAND_PEOPLE = ['olga@example.com', 'petr@example.com', 'igor@example.com'] as const;
export type StandPerson = (typeof STAND_PEOPLE)[number];

// Sessions saved by sign-in.setup.ts, one per person.
export const sessionFile = (email: StandPerson) => `node_modules/.cache/playwright-sessions/${email}.json`;

export async function signInWithForm(page: Page, email: string, password: string = STAND_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
}

// A page of a person who is already signed in (their saved session).
export async function pageAs(browser: Browser, email: StandPerson): Promise<Page> {
  const context = await browser.newContext({ storageState: sessionFile(email) });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
  return page;
}

export async function openAgent(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

// The chat window is recreated for the new conversation: wait for it before typing.
export async function newConversation(page: Page): Promise<void> {
  const before = page.url();
  await page.getByRole('button', { name: 'Новый разговор' }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByText(/^Здравствуйте! Я — агент/)).toBeVisible();
}

// Sends like a person: the chat window accepts a message once it knows the agent (until then the
// send button is inactive and the text just waits in the field).
export async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Напишите сообщение…' });
  await box.fill(text);
  const send = page.getByRole('button', { name: 'Отправить', exact: true }).last();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(box).toHaveValue('');
}
