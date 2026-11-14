import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../loader/registry.ts';
import { startFakeModel, type FakeModel, type FakeRequest } from '../models/fake-openai.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS } from '../runtime/agent-factory.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createLimiter } from './limiter.ts';
import { contextRoot } from '../workspace/layout.ts';
import { assertIsolationAvailable, createImageViewProcessor } from './workspace.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILLS = join(ROOT, 'core/skills');
const VENV = join(ROOT, '.venv-skills');
const SCRIPTS = join(SKILLS, 'read-documents/scripts');
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

async function runAs(userId: string, projectId?: string): Promise<void> {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, userId);
  rc.set(REQUEST_KEYS.modelId, 'test-paid');
  rc.set(REQUEST_KEYS.threadId, `t-${userId}`);
  if (projectId) rc.set(REQUEST_KEYS.projectId, projectId);
  await agent.generate('Прочитай файл', { requestContext: rc, maxSteps: 3 });
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
    skillDirs: [SKILLS],
    subagents: [],
    connectorIds: [],
    toolSystems: {},
  };
  const gateway = { modelConfig: () => Promise.resolve({ providerId: 'fake', modelId: 'fake', url: model.url, apiKey: 'x', headers: {} }) };
  agent = createMastraAgent(rt, {
    gateway,
    firstChunkMs: FALLBACK_FIRST_CHUNK_MS,
    sandbox: { deps: { workspaceRoot, skillsVenv: VENV, limiter: createLimiter(8, 60_000) }, isolation: assertIsolationAvailable() },
    processorsFor: () => ({ input: [createImageViewProcessor(workspaceRoot)], output: [] }),
  });
  process.env.BBA_TEST_SECRET = 'app-secret-value';
});
afterAll(async () => {
  await model.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('sandbox', () => {
  it('reads PDF, Word and Excel with the skill scripts inside the employee’s folder', async () => {
    const dir = contextRoot(workspaceRoot, 'olga', null);
    writeFileSync(join(dir, 'invoice.pdf'), pdfWithText('Invoice total 98765'));
    execFileSync(join(VENV, 'bin/python'), ['-c', `
from docx import Document; d=Document(); d.add_paragraph('Договор поставки №17'); t=d.add_table(rows=2, cols=2); t.cell(0,0).text='Позиция'; t.cell(0,1).text='Цена'; t.cell(1,0).text='Бетон'; t.cell(1,1).text='4500'; d.save('${dir}/contract.docx')
from openpyxl import Workbook; w=Workbook(); s=w.active; s.title='Цены'; s.append(['Поставщик','Сумма']); s.append(['Альфа-Строй', 120000]); w.save('${dir}/prices.xlsx')
`]);
    const cases: [string, string[]][] = [
      [`python3 "${SCRIPTS}"/read_pdf.py invoice.pdf`, ['Страница 1', 'Invoice total 98765']],
      [`python3 "${SCRIPTS}"/read_docx.py contract.docx`, ['Договор поставки №17', '| Бетон | 4500 |']],
      [`python3 "${SCRIPTS}"/read_xlsx.py prices.xlsx`, ['Лист «Цены»', '| Альфа-Строй | 120000 |']],
    ];
    for (const [cmd, expected] of cases) {
      model.script(command(cmd), { text: 'Готово.' });
      await runAs('olga');
      const out = lastToolOutput();
      for (const e of expected) expect(out).toContain(e.replace(/\|/g, '\\\\|').replace(/\\\\\|/g, '|'));
    }
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
    model.script(command(`python3 "${SCRIPTS}"/read_pdf.py scan.pdf`), { text: 'Похоже на скан.' });
    await runAs('olga');
    expect(lastToolOutput()).toContain('похожа на скан');

    model.script(command(`python3 "${SCRIPTS}"/render_pdf_page.py scan.pdf 1`), { toolCalls: [{ name: 'view_image', args: { path: '.renders/scan-p1.png' } }] }, { text: 'Вижу пустую страницу.' });
    await runAs('olga');
    const last = JSON.stringify(model.requests.at(-1)!.messages);
    expect(last).toContain('data:image/png;base64,');
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
