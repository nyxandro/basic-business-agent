// The document viewer (spec, section 8.27; decisions of the owner 18.11): the Word document the agent made
// opens in place — LibreOffice of the stand's real sandbox turns it into PDF, PDF.js draws its pages — with
// the scale, «По ширине», «Скачать» beside «Закрыть»; on a phone «Назад» closes it and leaves the chat.
import { expect, test, type Page } from '@playwright/test';
import { newConversation, openAgent, pageAs, say } from './helpers.ts';
import { STAND_DOCUMENT } from './stand-model.ts';

async function documentInChat(page: Page) {
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Сделай документ Word с КП');
  await expect(page.getByText(STAND_DOCUMENT, { exact: true })).toBeVisible();
}

test('the Word document of the agent opens in the viewer with its pages and the scale', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await documentInChat(page);
  await page.getByRole('button', { name: `Открыть ${STAND_DOCUMENT}` }).click();
  const viewer = page.getByRole('dialog', { name: STAND_DOCUMENT });
  // A page drawn by PDF.js: its canvas, and the text layer to select from.
  await expect(viewer.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(viewer.locator('.pdfViewer .textLayer').first()).toBeAttached();
  const scale = viewer.locator('[aria-live="polite"]');
  const fitted = await scale.textContent();
  await viewer.getByRole('button', { name: 'Увеличить' }).click();
  await expect(scale).not.toHaveText(fitted!);
  await viewer.getByRole('button', { name: 'По ширине' }).click();
  await expect(scale).toHaveText(fitted!);
  await expect(viewer.getByRole('link', { name: 'Скачать' })).toHaveAttribute('download', STAND_DOCUMENT);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(page.getByText(STAND_DOCUMENT, { exact: true })).toBeVisible();
});

test('on a phone the page fits the screen and «Назад» closes the viewer, not the chat', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com', { width: 390, height: 844 });
  await documentInChat(page);
  const chat = page.url();
  await page.getByRole('button', { name: `Открыть ${STAND_DOCUMENT}` }).click();
  const viewer = page.getByRole('dialog', { name: STAND_DOCUMENT });
  const pageBox = viewer.locator('.pdfViewer .page').first();
  await expect(pageBox).toBeVisible({ timeout: 30_000 });
  // Fitted to the width: no wider than the screen.
  expect((await pageBox.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.goBack();
  await expect(viewer).toBeHidden();
  expect(page.url()).toBe(chat);
  await expect(page.getByText(STAND_DOCUMENT, { exact: true })).toBeVisible();
});
