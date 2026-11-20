// Documents of the agent (spec, section 8.18): the agent makes a Word file in the employee's folder
// with the package the document skills use, and the answer shows it with «Скачать».
import { readFileSync } from 'node:fs';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_DOCUMENT } from './stand-model.ts';

test('an employee asks for a Word document and downloads it from the answer', async ({ browser }) => {
  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Сделай документ Word с КП');
  await expect(page.getByText('Готово: документ ниже, его можно скачать.')).toBeVisible();
  await expect(page.getByText(STAND_DOCUMENT, { exact: true })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: `Скачать ${STAND_DOCUMENT}` }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(STAND_DOCUMENT);
  // A real Word document: a zip archive with the document part inside.
  const bytes = readFileSync(await file.path());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.includes(Buffer.from('word/document.xml'))).toBe(true);

  // After a reload the block is still there: it is drawn from the saved result of the call.
  await page.reload();
  await expect(page.getByRole('link', { name: `Скачать ${STAND_DOCUMENT}` })).toBeVisible();
});
