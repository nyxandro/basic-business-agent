// What the agent is told of the letterhead, the director and the stamp (docs/specs/[20.11.2026]-org-letterhead.md): a
// system message after the layers of the prompt (core/prompts/layers.ts). The director outranks a name in the free text
// of the requisites; the letterhead goes before «a new document» of the docs skill (its own description mentions
// letterheads, and the model would make a new one). Only a responsible person's agent hears of the mark and the tool;
// any other gets one line and no way to put the stamp (decision of the owner 21.11, F1).
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { abilitiesOf } from '../abilities/abilities.ts';
import { requireContextValue, REQUEST_KEYS } from '../runtime/request-keys.ts';
import { readDirector, readWithoutStamp } from './assets.ts';
import { orgFilePaths, type OrgFilePaths } from './files.ts';
import { isSigner } from './signers.ts';

export const SIGN_TOOL = 'org_sign_document';
export const SIGN_MARK = '[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]';
export const LETTERHEAD_SKILL = 'letterhead';
// «Печать и подпись» — or «подпись» alone in an organisation working without a stamp (decision of the owner 21.11).
const sealWords = (withStamp: boolean) => (withStamp ? 'Печать и подпись' : 'Подпись');
export function notASigner(withStamp: boolean): string {
  return `${sealWords(withStamp)} руководителя ты не ставишь; если просят — скажи, что это делают ответственные лица, и оставь строку для подписи.`;
}
// Only a responsible person's agent hears how the stamp is put (decision of the owner 21.11, F1): the shared skill of the
// letterhead says nothing of the mark or the tool.
function signerRule(withStamp: boolean): string {
  return [
    `${sealWords(withStamp)} руководителя ставишь только по прямой просьбе сотрудника, в документ Word${withStamp ? '' : ' (печати у организации нет — инструмент ставит одну подпись)'}:`,
    `- вместо всей строки подписи — отдельным абзацем ровно ${SIGN_MARK}; должность и ФИО руководителя не пиши ни в этом абзаце, ни строкой выше или ниже — инструмент напишет их сам;`,
    `- сохрани документ и вызови ${SIGN_TOOL} с путём файла и видом документа (kind): letter — письмо, commercial_offer — КП, minutes — протокол, certificate — справка, contract — договор, act — акт, waybill — накладная, other — другое; называй вид честно;`,
    `- счёт-фактура, УПД, доверенность — факсимиле на них не допускается: метку не ставь, скажи, что их подписывают от руки или электронной подписью;`,
    `- инструмент ответил «нет метки» — поставь метку и вызови снова; сотрудник сказал «Нет» — замени метку обычной строкой подписи, чтобы в документе не осталось [[…]];`,
    `- после подписи покажи документ блоком файла.`,
  ].join('\n');
}

// What a responsible person cannot sign without: the agent says it instead of asking «Да» for nothing. `outdated` — the
// signature in the profile is of the former director (uploaded before the full name changed).
export type SealGap = 'stamp' | 'signature' | 'outdated' | 'director';
const GAP_TEXT: Record<SealGap, string> = { stamp: 'печати организации', signature: 'подписи руководителя', outdated: 'подписи нынешнего руководителя', director: 'ФИО руководителя' };

// «печати организации и подписи руководителя».
export function sealMissingWords(gaps: readonly SealGap[]): string {
  const what = gaps.map((g) => GAP_TEXT[g]);
  return what.length > 1 ? `${what.slice(0, -1).join(', ')} и ${what.at(-1)}` : what[0]!;
}

export function sealMissingText(gaps: readonly SealGap[], withStamp: boolean): string {
  return `${sealWords(withStamp)} руководителя ты ставишь, но сейчас нельзя: ${sealMissingWords(gaps)} в профиле нет. Если просят — скажи, что суперадминистратор может добавить это в «Профиле организации», и оставь строку для подписи.`;
}

export interface OrgDocsFacts {
  director: { position: string; fullName: string; signatureName: string };
  paths: OrgFilePaths;
  // null — not a responsible person; [] — may sign now; otherwise what is missing.
  sealGaps: SealGap[] | null;
  // The agent may run programs: without them it makes no documents (spec, section 8.30).
  commands: boolean;
  // A sub-agent answers the agent that called it and has no signing tool.
  level: 'top' | 'sub';
  // false — the organisation works without a stamp: the signature alone.
  withStamp: boolean;
}

export function orgDocsText(facts: OrgDocsFacts): string | null {
  const { director, paths } = facts;
  const lines: string[] = [];
  if (director.fullName) {
    const who = [director.position, director.fullName].filter(Boolean).join(' — ');
    lines.push(`Руководитель (главнее реквизитов): ${who}${director.signatureName ? `; в строке подписи — «${director.signatureName}»` : ''}.`);
  }
  if (facts.commands) {
    if (paths.blank) {
      lines.push(
        `Бланк организации: ${paths.blank} — копия фирменного бланка без текста. Письма, коммерческие предложения, протоколы и справки делай на нём (скилл ${LETTERHEAD_SKILL}), а не новым документом. Договоры, акты и другие документы по формам — на этих формах. Если сотрудник просит без бланка — без бланка.`,
      );
    }
    if (paths.logo) lines.push(`Логотип: ${paths.logo} — для презентаций, таблиц и документов без бланка.`);
    // A sub-agent answers the agent that called it and never puts the stamp: it hears nothing of it.
    if (facts.level === 'top') lines.push(facts.sealGaps === null ? notASigner(facts.withStamp) : facts.sealGaps.length === 0 ? signerRule(facts.withStamp) : sealMissingText(facts.sealGaps, facts.withStamp));
  }
  return lines.length > 0 ? `# Бланк, печать и подпись\n${lines.join('\n')}` : null;
}

// The signature was uploaded for another full name than the director's now (a signature uploaded before any name — for
// whoever is named later).
export const signatureOutdated = (uploadedFor: string | null, fullName: string): boolean => Boolean(uploadedFor && fullName && uploadedFor !== fullName);

// What a responsible person lacks to sign now; null — not a responsible person.
export async function sealGapsOf(db: Db, userId: string): Promise<SealGap[] | null> {
  if (!(await isSigner(db, userId))) return null;
  const { rows } = await db.query<{ kind: string; director_name: string | null }>("SELECT kind, director_name FROM app.org_assets WHERE kind IN ('stamp', 'signature')");
  const [director, withoutStamp] = await Promise.all([readDirector(db), readWithoutStamp(db)]);
  const signature = rows.find((r) => r.kind === 'signature');
  const gaps: SealGap[] = [];
  if (!withoutStamp && !rows.some((r) => r.kind === 'stamp')) gaps.push('stamp');
  if (!signature) gaps.push('signature');
  // A signature of the former director next to the name of the new one would be a forgery of the paper.
  else if (signatureOutdated(signature.director_name, director.fullName)) gaps.push('outdated');
  if (!director.signatureName) gaps.push('director');
  return gaps;
}

export function createOrgDocsPromptProcessor(deps: { db: Db; filesDir: string; level: 'top' | 'sub' }) {
  return {
    id: 'bba-org-docs-prompt',
    async processInput({ messages, systemMessages, requestContext }) {
      const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
      const commands = abilitiesOf(requestContext).commands;
      const [director, withoutStamp, paths, sealGaps] = await Promise.all([
        readDirector(deps.db),
        readWithoutStamp(deps.db),
        commands ? orgFilePaths(deps.db, deps.filesDir) : Promise.resolve({ blank: null, logo: null }),
        commands && deps.level === 'top' ? sealGapsOf(deps.db, userId) : Promise.resolve(null),
      ]);
      const text = orgDocsText({ director, paths, sealGaps, commands, level: deps.level, withStamp: !withoutStamp });
      return { messages, systemMessages: text ? [...systemMessages, { role: 'system' as const, content: text }] : systemMessages };
    },
  } satisfies Processor;
}
