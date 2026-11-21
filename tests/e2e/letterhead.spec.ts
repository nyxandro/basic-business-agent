// The letterhead, the stamp and the signature (docs/specs/[20.11.2026]-org-letterhead.md, step 7): a superadmin uploads
// them in «Профиль организации» — the pictures go through the canvas of a real browser — names the director and the
// responsible person; she asks for an offer on the letterhead with the signature, says «Да» and downloads it signed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { testPng } from '../../core/org-docs/test-pictures.ts';
import { expect, newConversation, openAgent, pageAs, say, test } from './helpers.ts';
import { STAND_ON_BLANK } from './stand-model.ts';

const BLANK = fileURLToPath(new URL('../../core/org-docs/fixtures/header-footer.docx', import.meta.url));

function partsText(files: Record<string, Uint8Array>, pattern: RegExp): string {
  return Object.entries(files)
    .filter(([name]) => pattern.test(name))
    .map(([, bytes]) => [...new TextDecoder().decode(bytes).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .join('');
}

test('a responsible person gets an offer on the letterhead with the stamp and the signature after «Да»', async ({ browser }) => {
  const admin = await pageAs(browser, 'igor@example.com');
  await admin.goto('/admin/org-profile');
  await admin.getByLabel('Бланк (Word): выбрать файл').setInputFiles(BLANK);
  await expect(admin.getByRole('button', { name: 'Так начнётся документ агента' })).toBeVisible();
  // A scan with white paper around the ink: the browser takes the white away before it goes.
  for (const [title, png] of [['Печать', testPng(400, 400, { alpha: false })], ['Подпись руководителя', testPng(500, 150, { alpha: false })]] as const) {
    await admin.getByLabel(`${title}: выбрать файл`).setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: png });
    const row = admin.getByRole('group', { name: title });
    await row.getByRole('button', { name: 'Сохранить' }).click();
    await expect(row.getByRole('button', { name: 'Заменить' })).toBeVisible();
  }
  const director = admin.getByRole('region', { name: 'Руководитель' });
  await director.getByLabel('Должность руководителя').fill('Генеральный директор');
  await director.getByLabel('ФИО руководителя').fill('Иванов Иван Петрович');
  await expect(director.getByLabel('Как подписывать')).toHaveValue('И. П. Иванов');
  await director.getByRole('button', { name: 'Сохранить' }).click();
  await expect(director.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  const signers = admin.getByRole('region', { name: 'Ответственные лица — печать и подпись' });
  await signers.getByRole('checkbox', { name: 'Ольга' }).check();
  await signers.getByRole('button', { name: 'Сохранить' }).click();
  await expect(signers.getByText('Назначено: 1 сотрудник')).toBeVisible();

  const page = await pageAs(browser, 'olga@example.com');
  await openAgent(page, 'Продажи');
  await newConversation(page);
  await say(page, 'Сделай КП на бланке с подписью директора');
  const card = page.getByRole('group', { name: 'Подтвердите действие' });
  await expect(card.getByText('Поставить печать организации и подпись руководителя в документ Word')).toBeVisible();
  await expect(card.getByText('коммерческое предложение', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Да, выполнить' }).click();
  await expect(page.getByText('Готово: документ ниже, его можно скачать.')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: `Скачать ${STAND_ON_BLANK}` }).click();
  const files = unzipSync(readFileSync(await (await download).path()));
  const body = partsText(files, /^word\/document\.xml$/);
  expect(body).toContain('Генеральный директор');
  expect(body).toContain('И. П. Иванов');
  expect(body).not.toContain('[[');
  // On the letterhead: its header and footer, its logo, then the signature and the stamp.
  expect(partsText(files, /^word\/header\d*\.xml$/)).toContain('Альфа-Строй');
  expect(Object.keys(files).filter((name) => name.startsWith('word/media/'))).toHaveLength(3);
});
