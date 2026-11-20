// Marks on a document in the viewer (spec, section 8.32; decisions of the owner 20.11, F42–F46): on the Word document the
// agent made, opened from the chat, a frame is drawn over its first page, commented and sent — one message of the
// person with the document and the picture of the marks; the viewer closes. Only from the chat — the component test
// (web/src/viewer/marks/marks-viewer.test.tsx).
import { type Page } from '@playwright/test';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_DOCUMENT } from './stand-model.ts';

async function openDocument(page: Page) {
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Сделай документ Word с КП');
  await page.getByRole('button', { name: `Открыть ${STAND_DOCUMENT}` }).click();
  const viewer = page.getByRole('dialog', { name: STAND_DOCUMENT });
  await expect(viewer.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 30_000 });
  return viewer;
}

test('a frame drawn on the document with a comment goes to the agent as one message', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  const viewer = await openDocument(page);
  await viewer.getByRole('button', { name: 'Пометки' }).click();
  await viewer.getByRole('button', { name: 'Прямоугольник' }).click();
  const box = (await viewer.locator('.pdfViewer .page').first().boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2, { steps: 8 });
  await page.mouse.up();
  const window = viewer.getByRole('dialog', { name: 'Пометка 1' });
  await window.getByRole('textbox', { name: 'Комментарий к пометке' }).fill('Поправь заголовок');
  await window.getByRole('button', { name: 'Готово' }).click();
  await expect(viewer.getByRole('button', { name: 'Пометка 1' })).toContainText('Поправь заголовок');

  // Kept in the browser: closed and opened again, the mark is there.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await page.getByRole('button', { name: `Открыть ${STAND_DOCUMENT}` }).click();
  await expect(viewer.getByRole('button', { name: 'Пометка 1' })).toBeVisible({ timeout: 30_000 });

  await viewer.getByRole('button', { name: 'Отправить агенту' }).click();
  await expect(viewer).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(`Пометки к документу «${STAND_DOCUMENT}» — 1:`)).toBeVisible();
  await expect(page.getByText(/1\. Стр\. 1, прямоугольник: Поправь заголовок/)).toBeVisible();
});
