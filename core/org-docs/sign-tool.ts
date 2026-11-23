// org_sign_document — the stamp and the signature of the director in a Word document of the agent's folder
// (docs/specs/[20.11.2026]-org-letterhead.md, F1; an organisation without a stamp — the signature alone, decision of the
// owner 21.11): only a responsible person's agent has it (core/runtime/agent-factory.ts),
// only after «Да» (core/approvals/policy.ts writes the journal), and the right is asked again after «Да». A forbidden
// kind of document or a document without the mark is refused before the card: nothing to say «Да» to. The signing runs
// in a one-off sandbox in a temporary folder — the pictures never reach the sandbox of the answer — and the result is
// written back in place through the held folder, the document as it was kept in the drafts of the conversation.
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { ActionDescription } from '@bba/contracts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import { describeTool } from '../approvals/describe.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import type { RunCommand } from '../preview/convert.ts';
import { keepBeforeWrite } from '../projects/trash.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue } from '../run-context/request-keys.ts';
import type { Limiter } from '../sandbox/limiter.ts';
import { runRoot } from '../sandbox/workspace.ts';
import { logEvent } from '../log/log.ts';
import { inFolderOf } from '../workspace/held-folder.ts';
import { draftsPath, existingInside, saveInFolder } from '../workspace/layout.ts';
import { assetContent, readDirector, readWithoutStamp } from './assets.ts';
import { ORG_SCRIPTS_DIR, ORG_WORK_PREFIX } from './blank.ts';
import { sealGapsOf, sealMissingWords, SIGN_MARK, SIGN_TOOL, type SealGap } from './prompt.ts';
import { assertUnpackable, fingerprintOf, hasMark, readSignable, rememberAsked, takeAsked } from './sign-document.ts';
import { isSigner } from './signers.ts';
import type { ChainService } from '../approvals/chains.ts';

export const DOCUMENT_KINDS = ['letter', 'commercial_offer', 'minutes', 'certificate', 'contract', 'act', 'waybill', 'invoice_factura', 'upd', 'power_of_attorney', 'other'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];
// A facsimile is not allowed on these even by agreement: the buyer risks the VAT deduction (art. 169 of the Tax Code;
// Minfin 10.04.2019 № 03-07-14/25364), a power of attorney (MNS 01.04.2004 № 18-0-09/000042).
const FORBIDDEN: ReadonlySet<DocumentKind> = new Set(['invoice_factura', 'upd', 'power_of_attorney']);
const BY_AGREEMENT = 'факсимиле допустимо, только если это прямо предусмотрено договором с клиентом';
// How the card names each kind; an act, a waybill and a contract carry the line about the agreement (section 13).
export const KIND_CHOICES: Record<DocumentKind, string> = {
  letter: 'письмо',
  commercial_offer: 'коммерческое предложение',
  minutes: 'протокол',
  certificate: 'справка',
  contract: `договор — ${BY_AGREEMENT}`,
  act: `акт — первичный документ: ${BY_AGREEMENT}`,
  waybill: `накладная — первичный документ: ${BY_AGREEMENT}`,
  invoice_factura: 'счёт-фактура',
  upd: 'УПД',
  power_of_attorney: 'доверенность',
  other: 'другой документ',
};

const SIGN_TIMEOUT_MS = 60_000;
// sign.py: no mark in it; not a Word document (2 is argparse's own).
const NO_MARKS = 3;
const NOT_A_DOCUMENT = 4;
const NOTE = 'Печать и подпись поставлены. Покажи документ сотруднику блоком файла.';
const GAP_NAMES: Record<SealGap, string> = { stamp: 'stamp', signature: 'signature', outdated: 'signature of the current director', director: 'director signature name' };

export interface SignDeps {
  db: Db;
  chains: ChainService;
  workspaceRoot: string;
  // A runner of the one-off sandbox that reads ORG_SCRIPTS_DIR.
  run: RunCommand;
  limiter: Limiter;
  workRoot: string;
}

type Ctx = { get(key: string): unknown } | undefined;
type ApprovalCtx = { requestContext?: Record<string, unknown> | Ctx; toolCallId: string };

const contextOf = (ctx: ApprovalCtx['requestContext']): Ctx => {
  if (!ctx) return undefined;
  if (typeof (ctx as { get?: unknown }).get === 'function') return ctx as Ctx;
  const plain = ctx as Record<string, unknown>;
  return { get: (key) => plain[key] };
};

const refusal = (code: string, message: string) => ({ proceed: false as const, output: { error: true, code, message } });

// The document after «Да»: the paper's line with the pictures, or with a line to sign by hand.
async function signed(deps: SignDeps, source: Buffer, director: { position: string; signatureName: string }, seal: { stamp: Buffer | null; signature: Buffer } | null): Promise<Buffer> {
  return deps.limiter.run(async () => {
    const dir = mkdtempSync(join(deps.workRoot, ORG_WORK_PREFIX));
    try {
      writeFileSync(join(dir, 'in.docx'), source);
      const args = [join(ORG_SCRIPTS_DIR, 'sign.py'), 'in.docx', 'out.docx', '--position', director.position, '--name', director.signatureName];
      if (seal) {
        writeFileSync(join(dir, 'signature.png'), seal.signature);
        args.push('--signature', 'signature.png');
        if (seal.stamp) {
          writeFileSync(join(dir, 'stamp.png'), seal.stamp);
          args.push('--stamp', 'stamp.png');
        }
      } else {
        args.push('--plain');
      }
      const result = await deps.run(dir, 'python3', args, SIGN_TIMEOUT_MS);
      if (result.exitCode === NO_MARKS) throw appError('APP_SIGN_NO_MARKS', 'sign.py found no mark');
      if (result.exitCode === NOT_A_DOCUMENT) throw appError('APP_SIGN_FORMAT', `sign.py: ${result.stdout.trim().slice(0, 300)}`);
      if (result.timedOut || result.exitCode !== 0) throw appError('APP_SIGN_FAILED', `sign.py failed with ${result.exitCode}: ${result.stderr.slice(-500)}`);
      return readFileSync(join(dir, 'out.docx'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The new bytes in place of the document; the document as it was — into the drafts, and into the answer's snapshot in a
// project (its previous version reaches the trash).
function replace(deps: SignDeps, ctx: Ctx, root: string, rel: string, before: Buffer, after: Buffer): void {
  const threadId = requireContextValue(ctx, REQUEST_KEYS.threadId);
  const projectId = optionalContextValue(ctx, REQUEST_KEYS.projectId);
  const ownerId = optionalContextValue(ctx, REQUEST_KEYS.projectOwnerId);
  const snapshot = optionalContextValue(ctx, REQUEST_KEYS.projectSnapshot);
  if (snapshot && projectId && ownerId) keepBeforeWrite(deps.workspaceRoot, { id: snapshot, projectId, ownerId }, [rel]);
  const name = basename(rel, extname(rel));
  saveInFolder(root, draftsPath(threadId, projectId !== null), `${name} — до подписи.docx`, before);
  const placed = inFolderOf(root, rel, false, (held, file) => {
    const temp = join(held, `.sign-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(temp, after, { flag: 'wx' });
      renameSync(temp, join(held, file));
    } finally {
      rmSync(temp, { force: true });
    }
    return true;
  });
  if (!placed) throw appError('APP_SIGN_FAILED', `the folder of ${rel} changed while it was signed`);
}

const NOT_ALLOWED_UNCHANGED = 'Печать и подпись руководителя ставят только ответственные лица. Документ не изменился.';

function notUploadedText(gaps: SealGap[], lined: boolean): string {
  return `Печать и подпись не поставлены: ${sealMissingWords(gaps)} в «Профиле организации» нет — добавить может суперадминистратор. ${lined ? 'В документе — строка для подписи от руки.' : 'Документ не изменился.'}`;
}

// No stamp after «Да»: the mark becomes the line to sign by hand, when there is a name to write. Whether it did.
async function plainLine(deps: SignDeps, ctx: Ctx, root: string, rel: string, before: Buffer, director: { position: string; signatureName: string }): Promise<boolean> {
  if (!director.signatureName) return false;
  try {
    replace(deps, ctx, root, rel, before, await signed(deps, before, director, null));
    return true;
  } catch (error) {
    // The refusal is the answer; a line not put is said in it, the failure is in the log.
    logEvent('warn', 'sign_plain_line_failed', { code: isAppError(error) ? error.code : 'APP_SIGN_FAILED', error: isAppError(error) ? error.code : (error as Error).name });
    return false;
  }
}

const SIGN_DESCRIPTION = `Поставить печать организации и подпись руководителя в документ Word. Только по прямой просьбе сотрудника. В документе на месте подписи — метка ${SIGN_MARK} отдельной строкой; должность и ФИО руководителя инструмент пишет сам из профиля организации.`;
const SIGN_INPUT = z.object({
  path: z.string().min(1).describe('Документ'),
  kind: z.enum(DOCUMENT_KINDS).describe('Вид документа'),
});

// How the card and the chat line name the action, with the kinds of documents in words — the same for everybody; without
// a stamp the card speaks of the signature alone (decision of the owner 21.11).
const DESCRIBED = describeTool(createTool({ id: SIGN_TOOL, description: SIGN_DESCRIPTION, inputSchema: SIGN_INPUT, requireApproval: true }) as AnyTool);
export function signActions(withStamp: boolean): Record<string, ActionDescription> {
  return { [SIGN_TOOL]: { ...DESCRIBED, title: withStamp ? DESCRIBED.title : 'Поставить подпись руководителя в документ Word', choices: { kind: KIND_CHOICES } } };
}

export async function signActionsFor(db: Db): Promise<Record<string, ActionDescription>> {
  return signActions(!(await readWithoutStamp(db)));
}

function signTool(deps: SignDeps): AnyTool {
  const tool = createTool({
    id: SIGN_TOOL,
    description: SIGN_DESCRIPTION,
    inputSchema: SIGN_INPUT,
    // Before the card: nothing to say «Да» to. A failure here must refuse too — Mastra shows the card after a hook that
    // threw (independent review 21.11).
    beforeApproval: async (input: { path: string; kind: DocumentKind }, ctx: ApprovalCtx) => {
      try {
        if (FORBIDDEN.has(input.kind)) {
          return refusal('APP_SIGN_FORBIDDEN_KIND', 'На счёте-фактуре, УПД и доверенности факсимиле подписи не допускается. Скажи сотруднику, что такой документ подписывают от руки или электронной подписью; печать и подпись не ставь.');
        }
        if (extname(input.path).toLowerCase() !== '.docx') return refusal('APP_SIGN_FORMAT', 'Печать и подпись ставятся только в документ Word (.docx). Сделай документ в .docx, затем вызови инструмент снова.');
        const requestContext = contextOf(ctx.requestContext);
        const bytes = readSignable(runRoot(deps.workspaceRoot, requestContext), input.path);
        if (!bytes) return refusal('APP_NOT_FOUND', `Файла ${input.path} в рабочей папке нет. Проверь путь.`);
        assertUnpackable(bytes);
        if (!hasMark(bytes)) return refusal('APP_SIGN_NO_MARKS', `В документе нет метки ${SIGN_MARK}. Поставь её отдельным абзацем на место строки подписи и вызови инструмент снова.`);
        await rememberAsked(deps.db, ctx.toolCallId, requireContextValue(requestContext, REQUEST_KEYS.userId), fingerprintOf(bytes));
        return undefined;
      } catch (error) {
        if (!isAppError(error)) {
          logEvent('error', 'sign_check_failed', { error });
          return refusal('APP_SIGN_FAILED', 'Не получилось проверить документ перед подписью. Скажи сотруднику и попробуй ещё раз позже.');
        }
        return refusal(error.code, error.code === 'APP_VALIDATION_FAILED' ? `Путь ${input.path} ведёт за пределы рабочей папки.` : error.userMessage);
      }
    },
    execute: async ({ path, kind }, context) => {
      const ctx = context?.requestContext as Ctx;
      if (FORBIDDEN.has(kind)) throw appError('APP_SIGN_FORBIDDEN_KIND', `kind ${kind} cannot carry a facsimile`);
      const userId = requireContextValue(ctx, REQUEST_KEYS.userId);
      const toolCallId = (context as { agent?: { toolCallId?: string } } | undefined)?.agent?.toolCallId;
      if (!toolCallId) throw appError('APP_SIGN_FAILED', 'the signing ran without the id of its call');
      const asked = await takeAsked(deps.db, toolCallId, userId);
      const root = runRoot(deps.workspaceRoot, ctx);
      const real = existingInside(root, path);
      const before = real ? readSignable(root, path) : null;
      if (!real || !before) throw appError('APP_NOT_FOUND', `no document ${path} to sign`, { userMessage: `Файла ${path} в рабочей папке нет.` });
      // Only the bytes the card was shown with: a document replaced at the same path meanwhile is not signed.
      if (!asked || asked !== fingerprintOf(before)) throw appError('APP_SIGN_CHANGED', 'the document changed after the card «Да» was shown');
      assertUnpackable(before);
      // From the real folder, as existingInside found the file: a link on the way to the workspace must not shift it.
      const rel = relative(realpathSync(root), real);
      const director = await readDirector(deps.db);
      // Asked again after «Да»: the person may have left the list, or the stamp gone, while the card waited.
      const allowed = await isSigner(deps.db, userId);
      const gaps = allowed ? await sealGapsOf(deps.db, userId) : null;
      if (!allowed || (gaps && gaps.length > 0)) {
        const lined = await plainLine(deps, ctx, root, rel, before, director);
        const result = lined ? 'the mark became a line to sign by hand' : 'the document was left as it was';
        if (!allowed) throw appError('APP_SIGN_NOT_ALLOWED', `the person is no longer a responsible signer: ${result}`, lined ? {} : { userMessage: NOT_ALLOWED_UNCHANGED });
        throw appError('APP_SIGN_NOT_UPLOADED', `missing ${gaps!.map((g) => GAP_NAMES[g]).join(', ')}: ${result}`, { userMessage: notUploadedText(gaps!, lined) });
      }
      const [withoutStamp, stamp, signature] = await Promise.all([readWithoutStamp(deps.db), assetContent(deps.db, 'stamp'), assetContent(deps.db, 'signature')]);
      if ((!withoutStamp && !stamp) || !signature) throw appError('APP_SIGN_NOT_UPLOADED', 'the stamp or the signature went away while signing');
      try {
        // Without a stamp the signature goes alone, even when a stamp uploaded before is kept.
        replace(deps, ctx, root, rel, before, await signed(deps, before, director, { stamp: withoutStamp ? null : stamp!.bytes, signature: signature.bytes }));
      } catch (error) {
        if (isAppError(error)) throw error;
        throw appError('APP_SIGN_FAILED', 'the signed document could not be written', { cause: error });
      }
      return { path, placed: true, kind, note: NOTE };
    },
  });
  return applyApprovalPolicy(tool as AnyTool, { readOnly: false, db: deps.db, chains: deps.chains });
}

export interface SignTools {
  // The tool of a responsible person who can sign now (the stamp, the signature and the director are in the profile).
  toolsFor(userId: string): Promise<Record<string, AnyTool>>;
}

export function createSignTools(deps: SignDeps): SignTools {
  const tool = signTool(deps);
  return {
    async toolsFor(userId): Promise<Record<string, AnyTool>> {
      const gaps = await sealGapsOf(deps.db, userId);
      return gaps && gaps.length === 0 ? { [SIGN_TOOL]: tool } : {};
    },
  };
}
