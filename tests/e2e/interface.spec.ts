// The agent's mark of «Интерфейс» (spec, section 8.17) in a browser: a phone photo stored sideways
// becomes an upright picture next to the agent's words for every employee; «Без значка» leaves only
// the words. The installation gets its spark back at the end: scenarios share one stand.
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { newConversation, openAgent, pageAs, say } from './helpers.ts';

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
async function save(admin: Page): Promise<void> {
  const saved = admin.waitForResponse((r) => r.url().endsWith('/app/api/admin/interface') && r.request().method() === 'PUT');
  await admin.getByRole('button', { name: 'Сохранить' }).click();
  expect((await saved).status()).toBe(200);
}

test('the admin’s phone photo stands upright next to the agent’s words; «Без значка» leaves only the words', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/interface');
  await admin.getByRole('radio', { name: 'Своя картинка' }).click();
  await admin.getByLabel('Файл картинки').setInputFiles(PHOTO);
  await expect(admin.getByRole('img', { name: 'Выбранная картинка' })).toBeVisible();
  await save(admin);

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
    await expect(page.getByText(/Вы написали: «Привет»/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Вы написали: «Привет»/)).toBeVisible();
    await expect(page.locator('[data-agent-mark="image"] img')).toHaveCount(1);

    await admin.getByRole('radio', { name: 'Без значка' }).click();
    await save(admin);
    await page.reload();
    await expect(page.getByText(/Вы написали: «Привет»/)).toBeVisible();
    await expect(page.locator('[data-agent-mark]')).toHaveCount(0);
  } finally {
    await admin.getByRole('radio', { name: 'Иконка' }).click();
    await admin.getByRole('radio', { name: 'Искра' }).click();
    await save(admin);
    await admin.close();
  }
});
