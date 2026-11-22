// Synonyms of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, scenario 6): the common dictionary of
// business words lives here; the groups those who keep a base add — «отгул, день отдыха» — in app.kb_synonyms, each in
// the base of its level (the organisation or a department). Words are kept as the search compares them: lower case,
// «ё» as «е».
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { normalize } from '../search/variants.ts';

export const COMMON_SYNONYMS: readonly string[][] = [
  ['возврат', 'рекламация', 'претензия'],
  ['договор', 'контракт', 'соглашение'],
  ['сотрудник', 'работник', 'персонал'],
  ['оплата', 'платеж', 'расчет'],
  ['скидка', 'дисконт'],
  ['доставка', 'отгрузка', 'поставка'],
  ['клиент', 'заказчик', 'покупатель'],
  ['зарплата', 'заработная плата', 'оклад'],
  ['командировка', 'служебная поездка'],
  ['руководитель', 'начальник', 'директор'],
  ['прайс', 'прайс-лист', 'цены', 'стоимость'],
  ['отпуск', 'отдых'],
];

export interface SynonymGroup {
  id: string;
  words: string[];
}

export const SYNONYM_WORDS_MAX = 20;

export async function listGroups(db: Db, departmentId: string | null): Promise<SynonymGroup[]> {
  const { rows } = await db.query<{ id: string; words: string[] }>(
    `SELECT group_id AS id, array_agg(word ORDER BY word) AS words FROM app.kb_synonyms WHERE department_id IS NOT DISTINCT FROM $1::uuid GROUP BY group_id ORDER BY min(created_at)`,
    [departmentId],
  );
  return rows;
}

export async function saveGroup(db: Db, actorUserId: string, departmentId: string | null, groupId: string | null, words: string[]): Promise<SynonymGroup> {
  const clean = [...new Set(words.map((w) => normalize(w).replace(/\s+/g, ' ').trim()).filter((w) => w !== ''))].slice(0, SYNONYM_WORDS_MAX);
  if (clean.length < 2) throw appError('APP_VALIDATION_FAILED', 'a synonym group of one word', { userMessage: 'В группе нужно хотя бы два слова.' });
  const id = groupId ?? randomUUID();
  await db.query('DELETE FROM app.kb_synonyms WHERE group_id = $1 AND department_id IS NOT DISTINCT FROM $2::uuid', [id, departmentId]);
  await db.query(
    `INSERT INTO app.kb_synonyms (group_id, word, scope, department_id, created_by) SELECT $1, w, $2, $3, $4 FROM unnest($5::text[]) AS w`,
    [id, departmentId ? 'department' : 'org', departmentId, actorUserId, clean],
  );
  return { id, words: clean.sort() };
}

export async function deleteGroup(db: Db, departmentId: string | null, groupId: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM app.kb_synonyms WHERE group_id = $1 AND department_id IS NOT DISTINCT FROM $2::uuid', [groupId, departmentId]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `synonym group ${groupId} not found`, { userMessage: 'Группа синонимов не найдена. Обновите страницу.' });
}
