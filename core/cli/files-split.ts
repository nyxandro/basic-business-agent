// pnpm files:split [--dry-run] — the one move to the folders of conversations (spec, section 8.33, step 161).
// Before it, the conversations of a person outside projects shared one folder, `files/`; now each works in its own,
// `files/chats/<number>/`, and sees only it. What a conversation showed the person — the files of its messages and
// the «Скачать» blocks of the agent — is copied into its folder under the same path, so its history opens them
// still; the scripts the agent wrote there go into its drafts, `.work/`; the rest of the shared folder is removed.
// Only for files on the server's disk: with a bucket the files are not where this looks.
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { GENUI_TOOL, splitAttachments } from '@bba/contracts';
import { createPool, type Db } from '../db/pool.ts';
import { draftResourceId } from '../memory/memory.ts';
import { threadProjectState } from '../projects/access.ts';
import { walkRegularFiles } from '../workspace/held-folder.ts';
import { CHATS, chatPath, DRAFTS, filesRoot } from '../workspace/layout.ts';

const DRAFT_TOOLS: ReadonlySet<string> = new Set([WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE, WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]);

export interface SplitCopy {
  threadId: string;
  // Paths from the person's `files/`.
  from: string;
  to: string;
  // `shown` — the person saw it in the conversation; `draft` — the agent wrote it there.
  kind: 'shown' | 'draft';
}

export interface UserSplit {
  userId: string;
  threads: number;
  copies: SplitCopy[];
  // Already in the folder of its conversation (written since the folders came): kept as it is.
  inPlace: string[];
  // Named by a conversation, but not a file of the shared folder (removed long ago, or a link).
  missing: string[];
  // The entries of `files/` that go, and what they hold.
  removed: string[];
  removedFiles: number;
  removedBytes: number;
}

export interface FilesSplitPlan {
  users: UserSplit[];
}

interface MessageRow {
  role: string;
  content: string;
}

interface ToolInvocation {
  toolName?: unknown;
  state?: unknown;
  args?: { path?: unknown } | null;
  result?: { shown?: unknown; path?: unknown } | null;
}

// A path of the shared folder as a conversation named it, or null: absolute, leading out, into the folders of
// conversations, or empty.
function sharedPath(path: unknown): string | null {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return null;
  const rel = posix.normalize(path.replaceAll('\\', '/'));
  if (rel === '.' || rel.startsWith('../') || rel === '..' || rel === CHATS || rel.startsWith(`${CHATS}/`)) return null;
  return rel;
}

// The files a conversation showed the person, and the files its agent wrote, in the order it named them.
function namedFiles(rows: readonly MessageRow[]): { shown: string[]; drafts: string[] } {
  const shown: string[] = [];
  const drafts: string[] = [];
  for (const row of rows) {
    const content = JSON.parse(row.content) as { parts?: { type?: string; text?: unknown; toolInvocation?: ToolInvocation }[] };
    for (const part of content.parts ?? []) {
      if (part.type === 'text' && row.role === 'user' && typeof part.text === 'string') {
        for (const file of splitAttachments(part.text).files) shown.push(file.path);
      }
      const call = part.type === 'tool-invocation' ? part.toolInvocation : undefined;
      if (!call) continue;
      if (call.toolName === GENUI_TOOL.file && call.result?.shown === true) shown.push(call.result.path as string);
      if (typeof call.toolName === 'string' && DRAFT_TOOLS.has(call.toolName) && call.state === 'result' && call.args) drafts.push(call.args.path as string);
    }
  }
  const paths = (list: unknown[]) => [...new Set(list.map(sharedPath).filter((p): p is string => p !== null))];
  return { shown: paths(shown), drafts: paths(drafts) };
}

async function assertFilesOnDisk(db: Db): Promise<void> {
  const { rows } = await db.query<{ mode: string }>('SELECT mode FROM app.storage_settings');
  if (rows[0]?.mode !== 'local') throw new Error('APP_FILES_SPLIT_BUCKET: the files are kept in a bucket; the split moves files on the server disk only');
}

async function planUser(db: Db, workspaceRoot: string, userId: string): Promise<UserSplit> {
  const root = filesRoot(workspaceRoot, userId, null);
  const files = new Map<string, number>();
  walkRegularFiles(
    root,
    (file) => {
      if (!file.rel.startsWith(`${CHATS}/`)) files.set(file.rel, file.size);
    },
    true,
  );
  const { rows: threads } = await db.query<{ id: string }>('SELECT id FROM mastra.mastra_threads WHERE "resourceId" = ANY($1) ORDER BY "createdAt", id', [[userId, draftResourceId(userId)]]);
  const split: UserSplit = { userId, threads: 0, copies: [], inPlace: [], missing: [], removed: [], removedFiles: 0, removedBytes: 0 };
  const missing = new Set<string>();
  for (const { id: threadId } of threads) {
    // A conversation of a project works in the project's folder, as it did before.
    if ((await threadProjectState(db, userId, threadId)).state === 'active') continue;
    split.threads += 1;
    const { rows } = await db.query<MessageRow>('SELECT role, content FROM mastra.mastra_messages WHERE thread_id = $1 ORDER BY "createdAt", id', [threadId]);
    const named = namedFiles(rows);
    const shown = new Set(named.shown);
    const targets = [
      ...named.shown.map((from) => ({ from, to: `${chatPath(threadId)}/${from}`, kind: 'shown' as const })),
      // A script the person was also shown is theirs: it stays where they saw it.
      ...named.drafts.filter((from) => !shown.has(from)).map((from) => ({ from, to: `${chatPath(threadId)}/${from.startsWith(`${DRAFTS}/`) ? from : `${DRAFTS}/${from}`}`, kind: 'draft' as const })),
    ];
    // `make.js` and `.work/make.js` of one conversation are one draft: the first named is taken.
    const taken = new Set<string>();
    for (const target of targets) {
      if (taken.has(target.to)) continue;
      taken.add(target.to);
      if (!files.has(target.from)) missing.add(target.from);
      else if (existsSync(join(root, target.to))) split.inPlace.push(target.to);
      else split.copies.push({ threadId, ...target });
    }
  }
  split.missing = [...missing];
  split.removed = existsSync(root) ? readdirSync(root).filter((name) => name !== CHATS) : [];
  split.removedFiles = files.size;
  for (const size of files.values()) split.removedBytes += size;
  return split;
}

// What the split would do; changes nothing.
export async function planFilesSplit(db: Db, workspaceRoot: string): Promise<FilesSplitPlan> {
  await assertFilesOnDisk(db);
  const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" ORDER BY "id"');
  const users: UserSplit[] = [];
  for (const { id } of rows) {
    if (existsSync(filesRoot(workspaceRoot, id, null))) users.push(await planUser(db, workspaceRoot, id));
  }
  return { users };
}

// Copies first, all of them: a failed copy stops the split before anything is removed.
export function applyFilesSplit(workspaceRoot: string, plan: FilesSplitPlan): void {
  for (const user of plan.users) {
    const root = filesRoot(workspaceRoot, user.userId, null);
    for (const copy of user.copies) {
      const [from, to] = [join(root, copy.from), join(root, copy.to)];
      mkdirSync(dirname(to), { recursive: true });
      // Two conversations never share a target; one already there is not overwritten.
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      // The drafts are cleaned by their age: a copy keeps the age of its file.
      const stat = statSync(from);
      utimesSync(to, stat.atime, stat.mtime);
    }
  }
  for (const user of plan.users) {
    const root = filesRoot(workspaceRoot, user.userId, null);
    for (const name of user.removed) rmSync(join(root, name), { recursive: true, force: true });
  }
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function report(plan: FilesSplitPlan, done: boolean): string {
  const lines = plan.users.map((u) => {
    const shown = u.copies.filter((c) => c.kind === 'shown').length;
    return [
      `${u.userId}: ${u.threads} conversations outside projects`,
      `  copied into their folders: ${shown} files shown to the person, ${u.copies.length - shown} drafts of the agent`,
      u.inPlace.length > 0 ? `  already in place, kept: ${u.inPlace.length}` : null,
      u.missing.length > 0 ? `  named by a conversation, but no such file: ${u.missing.join(', ')}` : null,
      `  ${done ? 'removed' : 'to remove'} from the shared folder: ${u.removed.length} entries, ${u.removedFiles} files, ${megabytes(u.removedBytes)}`,
    ]
      .filter((l) => l !== null)
      .join('\n');
  });
  return [done ? 'Files split into the folders of conversations.' : 'Dry run: nothing changed.', ...lines].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  if (args.some((a) => a !== '--dry-run')) {
    console.error('Usage: files-split.ts [--dry-run]');
    process.exit(1);
  }
  const [databaseUrl, workspaceRoot] = [process.env.DATABASE_URL, process.env.APP_WORKSPACE_DIR];
  if (!databaseUrl || !workspaceRoot) {
    console.error(`APP_CONFIG_INVALID: .env: ${databaseUrl ? 'APP_WORKSPACE_DIR' : 'DATABASE_URL'}: is not set`);
    process.exit(1);
  }
  const db = createPool(databaseUrl);
  try {
    const plan = await planFilesSplit(db, workspaceRoot);
    if (!dryRun) applyFilesSplit(workspaceRoot, plan);
    console.log(report(plan, !dryRun));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
