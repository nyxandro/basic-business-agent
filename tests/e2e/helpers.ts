// Steps shared by the end-to-end scenarios.
import { expect, type Browser, type Page } from '@playwright/test';

// TEST_PASSWORD of core/server/test-app.ts: the stand creates its people with it.
export const STAND_PASSWORD = 'correct-horse-battery';
export const STAND_PEOPLE = ['olga@example.com', 'petr@example.com', 'igor@example.com'] as const;
export type StandPerson = (typeof STAND_PEOPLE)[number];

// Sessions saved by sign-in.setup.ts, one per person.
export const sessionFile = (email: StandPerson) => `node_modules/.cache/playwright-sessions/${email}.json`;

// The gear of the side panel is there once the person is in.
const signedIn = (page: Page) => expect(page.getByRole('button', { name: 'Настройки' })).toBeVisible();

export async function signInWithForm(page: Page, email: string, password: string = STAND_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await signedIn(page);
}

// A page of a person who is already signed in (their saved session).
export async function pageAs(browser: Browser, email: StandPerson, viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ storageState: sessionFile(email), ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  await page.goto('/');
  if (!viewport || viewport.width >= 860) await signedIn(page);
  return page;
}

export async function openAgent(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('button', { name: `${name}. Выбрать агента` })).toBeVisible();
}

// The chat view is recreated for the new conversation: wait for its greeting before typing.
export async function newConversation(page: Page): Promise<void> {
  const before = page.url();
  await page.getByRole('button', { name: 'Новый разговор' }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page.getByRole('heading', { name: /^Чем помочь/ })).toBeVisible();
}

// Sends like a person: Enter in the field once the agent is known.
export async function say(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Сообщение агенту' });
  await box.fill(text);
  const send = page.getByRole('button', { name: 'Отправить', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(box).toHaveValue('');
}
