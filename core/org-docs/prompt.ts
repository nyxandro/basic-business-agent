// What the agent is told of the letterhead, the director and the stamp (docs/specs/[20.11.2026]-org-letterhead.md): a
// system message after the layers of the prompt (core/prompts/layers.ts). The director outranks a name in the free text
// of the requisites; the letterhead goes before «a new document» of the docs skill (its own description mentions
// letterheads, and the model would make a new one). Only a responsible person's agent hears of the mark and the tool;
// any other gets one line and no way to put the stamp (decision of the owner 21.11, F1).
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { abilitiesOf } from '../abilities/abilities.ts';
import { requireContextValue, REQUEST_KEYS } from '../runtime/request-keys.ts';
import { readDirector } from './assets.ts';
import { orgFilePaths, type OrgFilePaths } from './files.ts';
import { isSigner } from './signers.ts';

export const SIGN_TOOL = 'org_sign_document';
export const SIGN_MARK = '[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]';
export const LETTERHEAD_SKILL = 'letterhead';
export const NOT_A_SIGNER = 'Печать и подпись руководителя ты не ставишь; если просят — скажи, что это делают ответственные лица, и оставь строку для подписи.';
const SIGNER_RULE = `Печать и подпись руководителя ставишь только по прямой просьбе сотрудника: в документ Word — метка ${SIGN_MARK} отдельной строкой на месте подписи, затем ${SIGN_TOOL} (скилл ${LETTERHEAD_SKILL}).`;

// What a responsible person cannot sign without: the agent says it instead of asking «Да» for nothing.
export type SealGap = 'stamp' | 'signature' | 'director';
const GAP_TEXT: Record<SealGap, string> = { stamp: 'печати организации', signature: 'подписи руководителя', director: 'ФИО руководителя' };

export function sealMissingText(gaps: readonly SealGap[]): string {
  const what = gaps.map((g) => GAP_TEXT[g]);
  const listed = what.length > 1 ? `${what.slice(0, -1).join(', ')} и ${what.at(-1)}` : what[0];
  return `Печать и подпись руководителя ты ставишь, но сейчас нельзя: ${listed} в профиле нет. Если просят — скажи, что суперадминистратор может добавить это в «Профиле организации», и оставь строку для подписи.`;
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
    const signer = facts.level === 'top' ? facts.sealGaps : null;
    lines.push(signer === null ? NOT_A_SIGNER : signer.length === 0 ? SIGNER_RULE : sealMissingText(signer));
  }
  return lines.length > 0 ? `# Бланк, печать и подпись\n${lines.join('\n')}` : null;
}

// What a responsible person lacks to sign now; null — not a responsible person.
export async function sealGapsOf(db: Db, userId: string): Promise<SealGap[] | null> {
  if (!(await isSigner(db, userId))) return null;
  const { rows } = await db.query<{ kind: string }>("SELECT kind FROM app.org_assets WHERE kind IN ('stamp', 'signature')");
  const director = await readDirector(db);
  const gaps: SealGap[] = [];
  if (!rows.some((r) => r.kind === 'stamp')) gaps.push('stamp');
  if (!rows.some((r) => r.kind === 'signature')) gaps.push('signature');
  if (!director.signatureName) gaps.push('director');
  return gaps;
}

export function createOrgDocsPromptProcessor(deps: { db: Db; filesDir: string; level: 'top' | 'sub' }) {
  return {
    id: 'bba-org-docs-prompt',
    async processInput({ messages, systemMessages, requestContext }) {
      const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
      const commands = abilitiesOf(requestContext).commands;
      const [director, paths, sealGaps] = await Promise.all([
        readDirector(deps.db),
        commands ? orgFilePaths(deps.db, deps.filesDir) : Promise.resolve({ blank: null, logo: null }),
        commands && deps.level === 'top' ? sealGapsOf(deps.db, userId) : Promise.resolve(null),
      ]);
      const text = orgDocsText({ director, paths, sealGaps, commands, level: deps.level });
      return { messages, systemMessages: text ? [...systemMessages, { role: 'system' as const, content: text }] : systemMessages };
    },
  } satisfies Processor;
}
