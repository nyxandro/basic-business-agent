import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { withAttachments } from '@bba/contracts';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { Processor } from '@mastra/core/processors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../loader/registry.ts';
import { startFakeModel, type FakeModel, type FakeRequest } from '../models/fake-openai.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS, MODEL_CALL_MAX_MS } from '../runtime/agent-factory.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { SYSTEM_SKILLS_DIR } from '../skills-admin/system.ts';
import { createLimiter } from './limiter.ts';
import { contextRoot } from '../workspace/layout.ts';
import { findSandboxGaps } from './environment.ts';
import { assertIsolationAvailable, createImageViewProcessor } from './workspace.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// A skill of the company as the run of an employee gets it: the folder of one skill.
const SKILL = join(ROOT, 'skills/note-taking');
const VENV = join(ROOT, '.venv-skills');
let workspaceRoot: string;
let model: FakeModel;
let agent: Agent;

// A minimal one-page PDF with a text line, built by hand so the test needs no PDF writer.
function pdfWithText(text: string | null): Buffer {
  const content = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A red square of `size` pixels as a real PNG file.
// The time the prompt layers add to the latest message in the outgoing request (core/prompts/layers.ts).
const stampTime = {
  id: 'test-time-stamp',
  processLLMRequest({ prompt }) {
    const last = prompt.findLastIndex((m) => m.role === 'user');
    const message = prompt[last];
    if (!message || message.role !== 'user') return undefined;
    return { prompt: prompt.map((m, i) => (i === last ? { ...message, content: [...message.content, { type: 'text' as const, text: '\n\n(Сейчас: 19.11.2026 12:00, Europe/Moscow)' }] } : m)) };
  },
} satisfies Processor;

function png(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.writeUInt8(8, 8);
  head.writeUInt8(2, 9);
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function readFile(args: Record<string, unknown>) {
  return (req: FakeRequest) => {
    const tool = (req.tools ?? []).map((t) => t.function.name).find((n) => n.endsWith('read_file'));
    return { toolCalls: [{ name: tool ?? 'missing_read_file', args }] };
  };
}

function command(cmd: string) {
  return (req: FakeRequest) => {
    const tool = (req.tools ?? []).map((t) => t.function.name).find((n) => n.endsWith('execute_command'));
    return { toolCalls: [{ name: tool ?? 'missing_execute_command', args: { command: cmd } }] };
  };
}

function lastToolOutput(): string {
  const tools = model.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
  return JSON.stringify(tools.at(-1)?.content ?? '');
}

const PROJECT = '0b8e2a9a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

async function runAs(userId: string, projectId?: string, skills: string[] = [SKILL], text = 'Прочитай файл'): Promise<void> {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, userId);
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.threadId, `t-${userId}`);
  rc.set(REQUEST_KEYS.skillPaths, JSON.stringify(skills));
  if (projectId) {
    rc.set(REQUEST_KEYS.projectId, projectId);
    rc.set(REQUEST_KEYS.projectOwnerId, userId);
  }
  await agent.generate(text, { requestContext: rc, maxSteps: 3 });
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'bba-ws-'));
  model = await startFakeModel();
  const rt: AgentRuntime = {
    passport: { id: 'assistant', name: 'Помощник', description: 'x', plugins: [], readOnly: [], starters: [] },
    dir: '/x',
    instructions: 'Ты помощник.',
    tools: {},
    readOnly: new Set(),
    subagents: [],
    connectorIds: [],
    toolSystems: {},
  };
  const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
  agent = createMastraAgent(rt, {
    gateway,
    firstChunkMs: FALLBACK_FIRST_CHUNK_MS,
    stepMs: MODEL_CALL_MAX_MS,
    sandbox: { deps: { workspaceRoot, skillsVenv: VENV, limiter: createLimiter(8, 60_000) }, isolation: assertIsolationAvailable() },
    // As in core/runtime/mastra.ts: the layers add the time to the latest message before the pictures are looked for.
    processorsFor: () => ({ input: [stampTime, createImageViewProcessor(workspaceRoot)], output: [] }),
  });
  process.env.BBA_TEST_SECRET = 'app-secret-value';
});
afterAll(async () => {
  await model.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('sandbox', () => {
  // The ways the document skills read files (spec, section 8.18), inside the employee's folder.
  it('reads PDF, Word and Excel the way the document skills do, inside the employee’s folder', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    writeFileSync(join(dir, 'invoice.pdf'), pdfWithText('Invoice total 98765'));
    execFileSync(join(VENV, 'bin/python'), ['-c', `
from docx import Document; d=Document(); d.add_paragraph('Договор поставки №17'); t=d.add_table(rows=2, cols=2); t.cell(0,0).text='Позиция'; t.cell(0,1).text='Цена'; t.cell(1,0).text='Бетон'; t.cell(1,1).text='4500'; d.save('${dir}/contract.docx')
from openpyxl import Workbook; w=Workbook(); s=w.active; s.title='Цены'; s.append(['Поставщик','Сумма']); s.append(['Альфа-Строй', 120000]); w.save('${dir}/prices.xlsx')
`]);
    const cases: [string, string[]][] = [
      ['pdftotext -layout invoice.pdf -', ['Invoice total 98765']],
      [`python -c "import pdfplumber; print(pdfplumber.open('invoice.pdf').pages[0].extract_text())"`, ['Invoice total 98765']],
      ['pandoc contract.docx -t markdown', ['Договор поставки №17', 'Бетон', '4500']],
      ['markitdown prices.xlsx', ['## Цены', 'Альфа-Строй', '120000']],
    ];
    for (const [cmd, expected] of cases) {
      model.script(command(cmd), { text: 'Готово.' });
      await runAs('olga');
      const out = lastToolOutput();
      for (const e of expected) expect(out).toContain(e.replace(/\|/g, '\\\\|').replace(/\\\\\|/g, '|'));
    }
  });

  // Spec, section 8.18: what the system skills of documents run is there and works in the isolation.
  it('has the whole environment of the document skills on this machine', () => {
    expect(findSandboxGaps(VENV)).toEqual({ programs: [], python: [], node: [], ocrLanguages: [] });
  });

  it('runs LibreOffice, pandoc, poppler, tesseract, the Python libraries and the Node packages inside the isolation', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    execFileSync(join(VENV, 'bin/python'), ['-c', `
from docx import Document; d=Document(); d.add_paragraph('Договор поставки №17'); d.save('${dir}/env.docx')
from openpyxl import Workbook; w=Workbook(); s=w.active; s.append([2, 3, '=A1*B1']); w.save('${dir}/env.xlsx')
`]);
    const cases: [string, string][] = [
      // The file must be there, not only named in an error of ls.
      ['soffice -env:UserInstallation=file:///tmp/lo --headless --convert-to pdf env.docx >/dev/null 2>&1; test -s env.pdf && echo converted-docx', 'converted-docx'],
      ['pandoc env.docx -t plain', 'Договор поставки №17'],
      ['pdftoppm -png -r 40 -f 1 -l 1 env.pdf env-page && ls env-page*', 'env-page-1.png'],
      ['tesseract --list-langs', 'rus'],
      // LibreOffice computes the formula openpyxl only wrote down.
      [`mkdir -p calc && soffice -env:UserInstallation=file:///tmp/lo --headless --convert-to xlsx --outdir calc env.xlsx >/dev/null 2>&1; python -c "from openpyxl import load_workbook; print('value', load_workbook('calc/env.xlsx', data_only=True).active['C1'].value)"`, 'value 6'],
      [`python -c "import pptx, pandas, pdfplumber, reportlab, defusedxml, pdf2image, pytesseract, markitdown; print('python-ok')"`, 'python-ok'],
      [`node -e "require('docx'); require('pptxgenjs'); require('sharp'); require('react-icons/fa'); require('react-dom/server'); console.log('node-ok')"`, 'node-ok'],
    ];
    for (const [cmd, expected] of cases) {
      model.script(command(cmd), { text: 'Готово.' });
      await runAs('olga');
      expect(lastToolOutput(), cmd).toContain(expected);
    }
    // Caches and settings of the programs stay in the command's /tmp, not in the employee's files
    // (LibreOffice leaves an empty .config behind; nothing goes into it).
    const kept = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub), { recursive: true }) : []);
    expect(kept('.cache')).toEqual([]);
    expect(kept('.config')).toEqual([]);
  }, 120_000);

  it('offers the agent the system skills of documents with their folders, and their scripts run in the isolation', async () => {
    const system = ['docx', 'pptx', 'xlsx', 'pdf'].map((n) => join(SYSTEM_SKILLS_DIR, n));
    model.script({ text: 'Ок.' });
    await runAs('olga', undefined, system);
    const prompt = JSON.stringify(model.requests.at(-1)!.messages.filter((m) => m.role === 'system'));
    for (const dir of system) expect(prompt).toContain(dir);

    // The wrapper of LibreOffice the instructions of the skills call (scripts/office/soffice.py).
    const dir = contextRoot(workspaceRoot, 'olga', null);
    execFileSync(join(VENV, 'bin/python'), ['-c', `from docx import Document; d=Document(); d.add_paragraph('КП'); d.save('${dir}/kp.docx')`]);
    model.script(command(`python "${join(SYSTEM_SKILLS_DIR, 'docx')}/scripts/office/soffice.py" --headless --convert-to pdf kp.docx >/dev/null 2>&1; test -s kp.pdf && echo converted-kp`), { text: 'Готово.' });
    await runAs('olga', undefined, system);
    expect(lastToolOutput()).toContain('converted-kp');
  }, 60_000);

  // V14: the skills of a run are the employee's own set (core/skills-admin/runtime.ts).
  it('V14: a skill not given to the employee is neither offered, nor read, nor run', async () => {
    const system = () => JSON.stringify(model.requests.at(-1)!.messages.filter((m) => m.role === 'system'));
    model.script({ text: 'Ок.' });
    await runAs('olga');
    expect(system()).toContain('note-taking');

    model.script({ text: 'Ок.' });
    await runAs('petr', undefined, []);
    expect(system()).not.toContain('note-taking');
    model.script({ toolCalls: [{ name: 'skill', args: { name: 'note-taking' } }] }, { text: 'Ок.' });
    await runAs('petr', undefined, []);
    expect(lastToolOutput()).not.toContain('Заметки сотрудника');
    model.script({ toolCalls: [{ name: 'skill_read', args: { skillName: 'note-taking', path: 'SKILL.md' } }] }, { text: 'Ок.' });
    await runAs('petr', undefined, []);
    expect(lastToolOutput()).not.toContain('Заметки сотрудника');
    model.script(command(`cat "${SKILL}/SKILL.md"`), { text: 'Ок.' });
    await runAs('petr', undefined, []);
    expect(lastToolOutput()).toContain('No such file');

    model.script(command(`cat "${SKILL}/SKILL.md"`), { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('Заметки сотрудника');
  });

  it('keeps other employees’ folders, the app’s secrets, the network and the code out of reach', async () => {
    const other = contextRoot(workspaceRoot, 'igor', null);
    writeFileSync(join(other, 'secret.txt'), 'IGOR-ONLY');
    const probes: [string, string][] = [
      [`cat ${other}/secret.txt`, 'No such file'],
      ['echo "secret=[$BBA_TEST_SECRET]"', 'secret=[]'],
      [`python3 -c "import urllib.request;urllib.request.urlopen('http://1.1.1.1',timeout=3)"`, 'Error'],
      [`ls ${ROOT}/core`, 'No such file'],
    ];
    for (const [cmd, expected] of probes) {
      model.script(command(cmd), { text: 'Ок.' });
      await runAs('olga');
      expect(lastToolOutput()).toContain(expected);
    }
  });

  it('shows the model a scanned page: render it, then view_image puts the picture into the next request', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    writeFileSync(join(dir, 'scan.pdf'), pdfWithText(null));
    model.script(command('pdftotext scan.pdf - | wc -w'), { text: 'Текста нет — похоже на скан.' });
    await runAs('olga');
    expect(lastToolOutput()).toMatch(/\b0\b/);

    model.script(command('mkdir -p .renders && pdftoppm -png -r 50 -f 1 -l 1 scan.pdf .renders/scan'), { toolCalls: [{ name: 'view_image', args: { path: '.renders/scan-1.png' } }] }, { text: 'Вижу пустую страницу.' });
    await runAs('olga');
    const last = JSON.stringify(model.requests.at(-1)!.messages);
    expect(last).toContain('data:image/png;base64,');
  });

  // Spec, section 8.18: the file block of the chat with «Скачать».
  it('shows the employee a ready file of the folder with show_file, and refuses what is not a file there', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    mkdirSync(join(dir, 'черновики'), { recursive: true });
    writeFileSync(join(dir, 'КП «Ёлка».docx'), 'DOCX');
    const other = contextRoot(workspaceRoot, 'igor', null);
    writeFileSync(join(other, 'чужой.docx'), 'X');
    const show = (path: string) => ({ toolCalls: [{ name: 'show_file', args: { path } }] });

    for (const path of ['КП «Ёлка».docx', join(dir, 'КП «Ёлка».docx')]) {
      model.script(show(path), { text: 'Готово.' });
      await runAs('olga');
      // The tool result comes as JSON inside the JSON of the message.
      expect(lastToolOutput()).toContain('\\"shown\\":true');
      expect(lastToolOutput()).toContain('\\"path\\":\\"КП «Ёлка».docx\\"');
      expect(lastToolOutput()).toContain('\\"bytes\\":4');
    }
    // A link to a file outside the folder (the server reads files outside the sandbox).
    symlinkSync(join(other, 'чужой.docx'), join(dir, 'ссылка.docx'));
    for (const path of ['нет.docx', 'черновики', join(other, 'чужой.docx'), '../igor/files/чужой.docx', 'ссылка.docx']) {
      model.script(show(path), { text: 'Ок.' });
      await runAs('olga');
      expect(lastToolOutput(), path).toContain('\\"shown\\":false');
      expect(lastToolOutput(), path).toContain('Сохрани файл в рабочую папку');
    }
  });

  it('does not send the model a file of the server behind a link that looks like a picture', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    const secret = join(workspaceRoot, 'server-secret.png');
    writeFileSync(secret, png(16));
    symlinkSync(secret, join(dir, 'leak.png'));
    model.script({ toolCalls: [{ name: 'view_image', args: { path: 'leak.png' } }] }, { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('ведёт за пределы рабочей папки');
    expect(JSON.stringify(model.requests.at(-1)!.messages)).not.toContain('data:image/png;base64,');
  });

  it('opens a picture by its absolute path inside the folder, as the document skills pass it', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    mkdirSync(join(dir, 'слайды'), { recursive: true });
    writeFileSync(join(dir, 'слайды', 'slide-1.png'), png(32));
    model.script({ toolCalls: [{ name: 'view_image', args: { path: join(dir, 'слайды', 'slide-1.png') } }] }, { text: 'Вижу слайд.' });
    await runAs('olga');
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('data:image/png;base64,');
  });

  // A document skill renders a page, looks at it, then renders it anew: the first picture is gone.
  // Groq refuses a user message without content, which broke the whole answer (task #7).
  it('sends no empty message when a picture the model looked at earlier in the answer is gone', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    writeFileSync(join(dir, 'page-1.png'), png(16));
    model.script({ toolCalls: [{ name: 'view_image', args: { path: 'page-1.png' } }] }, command('rm page-1.png'), { text: 'Перерисую страницу.' });
    await runAs('olga');
    const messages = model.requests.at(-1)!.messages;
    expect(messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.length === 0)).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain('data:image/png;base64,');
  });

  it('gives the model the picture attached to the message with the message itself', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'яхта.png'), png(64));
    model.script({ text: 'Вижу красный квадрат.' });
    await runAs('olga', undefined, [SKILL], withAttachments('видишь картинку?', [{ name: 'яхта.png', path: 'files/яхта.png' }]));
    const user = model.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(user.content)).toContain('видишь картинку?');
    expect(JSON.stringify(user.content)).toContain('data:image/png;base64,');
  });

  it('keeps pictures and raw bytes out of read_file: the model is told to use view_image or the skill', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'фото.png'), png(64));
    writeFileSync(join(dir, 'files', 'счёт.pdf'), pdfWithText('Invoice'));
    model.script(readFile({ path: 'files/фото.png' }), { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('view_image');
    expect(lastToolOutput()).not.toContain('iVBORw0KGgo');
    model.script(readFile({ path: 'files/счёт.pdf', encoding: 'base64' }), { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('скиллами pdf, docx, xlsx и pptx');
    expect(lastToolOutput()).not.toContain('JVBERi0');
  });

  it('tells the model how to open the pictures it cannot see as they are and an archive (request of the owner 17.11)', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'скан.webp'), png(64));
    writeFileSync(join(dir, 'files', 'архив.zip'), 'PK\u0003\u0004');
    model.script(readFile({ path: 'files/скан.webp' }), { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('PNG');
    expect(lastToolOutput()).toContain('view_image');
    model.script({ toolCalls: [{ name: 'view_image', args: { path: 'files/скан.webp' } }] }, { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('переведи');
    model.script(readFile({ path: 'files/архив.zip' }), { text: 'Ок.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('python3 -m zipfile -e');
  });
});

describe('concurrency limit', () => {
  it('lets a command wait for a free slot and then gives up with APP_SANDBOX_BUSY', async () => {
    const limiter = createLimiter(2, 100);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const busy = [limiter.run(() => hold), limiter.run(() => hold)];
    await expect(limiter.run(() => Promise.resolve('third'))).rejects.toMatchObject({ code: 'APP_SANDBOX_BUSY' });
    const waiting = limiter.run(() => Promise.resolve('fourth'));
    release();
    await Promise.all(busy);
    await expect(waiting).resolves.toBe('fourth');
  });
});

describe('project folder (V21)', () => {
  it('lets the agent of a project conversation work only inside the project files and never remove the folder itself', async () => {
    const general = contextRoot(workspaceRoot, 'olga', null);
    writeFileSync(join(general, 'personal.txt'), 'PERSONAL');
    const root = contextRoot(workspaceRoot, 'olga', PROJECT);
    writeFileSync(join(root, 'смета.txt'), 'SMETA');

    model.script(command('cat смета.txt && echo new > итог.txt && cat итог.txt'), { text: 'Ок.' });
    await runAs('olga', PROJECT);
    expect(lastToolOutput()).toContain('SMETA');
    expect(existsSync(join(root, 'итог.txt'))).toBe(true);

    model.script(command(`cat ${general}/personal.txt`), { text: 'Ок.' });
    await runAs('olga', PROJECT);
    expect(lastToolOutput()).toContain('No such file');

    model.script(command('rm -rf "$(pwd)"; ls -a "$(pwd)"'), { text: 'Ок.' });
    await runAs('olga', PROJECT);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, 'смета.txt'))).toBe(false);
  });
});
