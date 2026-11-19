// The line of the errand of the internet (spec, section 8.30): the task while the researcher works, the number of
// the sources when it is done, the code when it failed.
import { describe, expect, it } from 'vitest';
import { toolSummary } from './tool-summary.ts';

const agent = { systems: { tools: {}, prefixes: {} }, actions: {} };

describe('the line of the internet', () => {
  it('names the task while it runs, shortened when long', () => {
    expect(toolSummary('web_research', 'executing', undefined, agent, { task: 'Найди цены на профнастил С21' })).toEqual({ state: 'running', text: 'Ищу в интернете: Найди цены на профнастил С21' });
    const long = toolSummary('web_research', 'inProgress', undefined, agent, { task: 'а'.repeat(200) });
    expect(long.text.endsWith('…')).toBe(true);
    expect(long.text.length).toBeLessThan(100);
  });

  it('counts the sources when done and names the code when it failed', () => {
    const done = toolSummary('web_research', 'complete', JSON.stringify({ answer: '520 ₽', sources: [{ title: 'Цены', address: 'https://example.com' }, { title: 'Прайс', address: 'https://example.org' }] }), agent, { task: 'x' });
    expect(done).toMatchObject({ state: 'done', text: 'Поиск в интернете · 2 источника', readOnly: true });
    const failed = toolSummary('web_research', 'complete', JSON.stringify({ error: true, code: 'APP_WEB_RESEARCH_FAILED', message: 'не получилось' }), agent, { task: 'x' });
    expect(failed).toEqual({ state: 'failed', text: 'Поиск в интернете не получился', code: 'APP_WEB_RESEARCH_FAILED' });
  });
});
