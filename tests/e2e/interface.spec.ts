// The agent's own mark (spec, section 8.17; decision of the owner 16.11) in a browser: a phone photo
// stored sideways, set in «Значок» on the agent's page, becomes an upright picture next to that
// agent's words for every employee; the switch of «Интерфейс» turned off leaves only the words. The
// installation gets its spark and its switch back at the end: scenarios share one stand.
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';

// 120×80 pixels stored sideways with EXIF Orientation 6; seen upright it is red above, blue below.
const PHOTO = fileURLToPath(new URL('./fixtures/rotated-photo.jpg', import.meta.url));

// The TypeScript settings of the repository have no browser types (DOM): the few used in the page.
type Picture = { naturalWidth: number; naturalHeight: number };
type Canvas = {
  width: number;
  height: number;
  getContext(kind: '2d'): { drawImage(image: Picture, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } } | null;
};
type InPage = { document: { createElement(tag: 'canvas'): Canvas } };

const sizeOf = (picture: Locator) => picture.evaluate((node) => [(node as unknown as Picture).naturalWidth, (node as unknown as Picture).naturalHeight]);

// Which colour the picture shows near its top and its bottom, as the browser draws it.
async function topAndBottom(picture: Locator): Promise<{ top: string; bottom: string }> {
  return picture.evaluate((node) => {
    const img = node as unknown as Picture;
    const { document } = globalThis as unknown as InPage;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(img, 0, 0);
    const colour = (y: number) => {
      const { data } = context.getImageData(Math.floor(img.naturalWidth / 2), y, 1, 1);
      return data[0]! > data[2]! ? 'red' : 'blue';
    };
    return { top: colour(Math.floor(img.naturalHeight * 0.1)), bottom: colour(Math.floor(img.naturalHeight * 0.9)) };
  });
}

// Waits for the server's answer: the notice of an earlier save may still be on the screen.
async function saveMark(admin: Page): Promise<void> {
  const saved = admin.waitForResponse((r) => r.url().endsWith('/app/api/admin/agents/sales/mark') && r.request().method() === 'PUT');
  await admin.getByRole('button', { name: 'Сохранить' }).click();
  expect((await saved).status()).toBe(200);
}

async function showMarks(admin: Page, on: boolean): Promise<void> {
  await admin.goto('/admin/interface');
  const show = admin.getByRole('switch', { name: 'Показывать значок агента в чате' });
  if ((await show.getAttribute('aria-checked')) === String(on)) return;
  const saved = admin.waitForResponse((r) => r.url().endsWith('/app/api/admin/interface') && r.request().method() === 'PUT');
  await show.click();
  expect((await saved).status()).toBe(200);
  await expect(show).toHaveAttribute('aria-checked', String(on));
}

test('the admin’s phone photo of an agent stands upright next to its words; the switch of «Интерфейс» leaves only the words', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/agents');
  await admin.getByRole('list', { name: 'Агенты' }).getByRole('link', { name: /^Продажи/ }).click();
  await admin.getByRole('navigation', { name: 'Разделы агента' }).getByRole('link', { name: 'Значок' }).click();
  await admin.getByRole('radio', { name: 'Своя картинка' }).click();
  await admin.getByLabel('Файл картинки').setInputFiles(PHOTO);
  await expect(admin.getByRole('img', { name: 'Выбранная картинка' })).toBeVisible();
  await saveMark(admin);

  try {
    const page = await pageAs(browser, 'olga@example.com');
    await openAgent(page, 'Продажи');
    await newConversation(page);
    const welcome = page.locator('[data-agent-mark="image"] img');
    await expect(welcome).toHaveJSProperty('complete', true);
    // Cut to a square of at most 256 px by the browser, upright by EXIF.
    expect(await sizeOf(welcome)).toEqual([80, 80]);
    expect(await topAndBottom(welcome)).toEqual({ top: 'red', bottom: 'blue' });

    await say(page, 'Привет');
    // The stand's model repeats the message in lower case, with the time the server adds to it.
    await expect(page.getByText(/Вы написали: «привет/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Вы написали: «привет/)).toBeVisible();
    await expect(page.locator('[data-agent-mark="image"] img')).toHaveCount(1);

    await showMarks(admin, false);
    await page.reload();
    await expect(page.getByText(/Вы написали: «привет/)).toBeVisible();
    await expect(page.locator('[data-agent-mark]')).toHaveCount(0);
  } finally {
    await showMarks(admin, true);
    await admin.goto('/admin/agents/sales/mark');
    await admin.getByRole('radio', { name: 'Иконка' }).click();
    await admin.getByRole('radio', { name: 'Искра' }).click();
    await saveMark(admin);
    await admin.close();
  }
});
