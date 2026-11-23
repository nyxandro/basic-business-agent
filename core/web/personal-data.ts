// Documents of people never leave through the internet of agents (spec, section 8.30; decisions of the owner
// 19.11): a passport, a SNILS or a card number in a search query, in the task of the researcher or in the address
// of a page — when «Маскирование» masks that kind. Phones, mail and INN do go (a company's line, a counterparty's
// INN — an entrepreneur's INN has 12 digits like a person's). The masking gives the tools the real values back,
// so this is the only place they are stopped.
import type { MaskingKind } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';
import { detect } from '../masking/detect.ts';
import { getMaskingKinds } from '../masking/settings.ts';
import { logEvent } from '../log/log.ts';

const DOCUMENTS: readonly MaskingKind[] = ['passport', 'snils', 'card'];

export const PERSONAL_DATA_MESSAGE =
  'В запросе есть персональные данные (паспорт, СНИЛС или номер карты). В интернет такие данные не отправляются — так настроено в организации. Скажи об этом сотруднику; если можно, обойдись без этих данных.';

// An address is read as people write it: «%20» and «+» are spaces, «4510%20123456» is a passport. Each run of
// escapes is decoded on its own: one broken «%» elsewhere does not hide the rest.
function readable(text: string): string {
  return text.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch (error) {
      // Bytes that are no UTF-8 (an old Russian site's address): the run stays as written.
      if (error instanceof URIError) return run;
      throw error;
    }
  });
}

// The kind of a document of a person found in `text`, or null. Logged without the value.
export async function personalDocumentIn(db: Db, text: string, tool: string): Promise<MaskingKind | null> {
  const masked = await getMaskingKinds(db);
  const kinds = new Set(DOCUMENTS.filter((k) => masked.has(k)));
  if (kinds.size === 0) return null;
  const found = detect(readable(text), kinds)[0]?.kind ?? null;
  if (found) logEvent('info', 'web_personal_data_refused', { tool, kind: found });
  return found;
}
