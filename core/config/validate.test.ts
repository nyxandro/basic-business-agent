import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateInstallation, type ConfigProblem, type InstallationSources } from './validate.ts';


function sources(patch: Partial<InstallationSources> = {}): InstallationSources {
  return {
    app: {
      name: 'Альфа-Строй',
      timezone: 'Europe/Moscow',
      masking: { initialKinds: ['passport', 'snils', 'card', 'inn'] },
      limits: { initialOrgMonthlyRub: 50_000, initialUserMonthlyRub: 3_000, initialDailySubscriptionTokens: 500_000 },
    },
    pluginSettings: { mail: { host: 'imap.example.com' } },
    plugins: [
      { dir: 'mail', passport: { name: 'mail', title: 'Почта', settings: z.object({ host: z.string() }), secrets: ['MAIL_PASSWORD'], readOnly: ['search'] } },
    ],
    agents: [
      {
        dir: 'sales',
        passport: { id: 'sales', name: 'Продажи', description: 'Помогает отделу продаж', plugins: ['mail'], readOnly: [], starters: ['Покажи мои сделки'] },
        instructions: 'Ты агент отдела продаж.',
      },
    ],
    env: { MAIL_PASSWORD: 'secret' },
    ...patch,
  };
}

function problemsOf(src: InstallationSources): ConfigProblem[] {
  try {
    validateInstallation(src);
  } catch (error) {
    expect(error).toMatchObject({ code: 'APP_CONFIG_INVALID' });
    return (error as { details: { problems: ConfigProblem[] } }).details.problems;
  }
  throw new Error('expected APP_CONFIG_INVALID');
}

describe('validateInstallation', () => {
  it('accepts a correct installation and returns parsed settings', () => {
    const inst = validateInstallation(sources());
    expect(inst.agents[0]?.passport.id).toBe('sales');
    expect(inst.plugins[0]?.settings).toEqual({ host: 'imap.example.com' });
  });

  it('refuses a model in the agent passport: models are chosen in «Нейросеть», not in files', () => {
    const src = sources();
    (src.agents[0]!.passport as { model?: string }).model = 'main';
    expect(problemsOf(src)).toMatchObject([{ file: 'agents/sales/agent.ts', message: expect.stringContaining('"model"') }]);
  });

  it('reports a missing plugin secret as a field of .env', () => {
    expect(problemsOf(sources({ env: {} }))).toEqual([{ file: '.env', field: 'MAIL_PASSWORD', message: 'is required by plugin "mail"' }]);
  });

  it('reports an agent without an id', () => {
    const src = sources();
    delete (src.agents[0]!.passport as { id?: string }).id;
    expect(problemsOf(src)).toMatchObject([{ file: 'agents/sales/agent.ts', field: 'id' }]);
  });

  it('reports plugin settings by plugin name and field', () => {
    expect(problemsOf(sources({ pluginSettings: { mail: {} } }))).toMatchObject([{ file: 'config/plugins.ts', field: 'mail.host' }]);
  });

  it('reports settings for a plugin that is not installed', () => {
    expect(problemsOf(sources({ pluginSettings: { mail: { host: 'x' }, crm: {} } }))).toEqual([
      { file: 'config/plugins.ts', field: 'crm', message: 'there is no such plugin in plugins/' },
    ]);
  });

  it('reports an agent using a plugin that is not installed, a missing prompt and a bad time zone together', () => {
    const src = sources();
    (src.agents[0]!.passport as { plugins: string[] }).plugins = ['mail', 'bitrix24'];
    src.agents[0]!.instructions = '   ';
    (src.app as { timezone: string }).timezone = 'Moscow';
    expect(problemsOf(src).map((p) => `${p.file}: ${p.field}`)).toEqual([
      'config/app.ts: timezone',
      'agents/sales/agent.ts: plugins',
      'agents/sales/instructions.md: (file)',
    ]);
  });

  it('rejects two folders with the same agent id', () => {
    const src = sources();
    src.agents.push({ ...src.agents[0]!, dir: 'sales-copy' });
    expect(problemsOf(src)).toEqual([{ file: 'agents/', field: 'id', message: 'agent id "sales" is used by more than one folder' }]);
  });

  it('puts every problem into the error text for the start-up log', () => {
    expect(() => validateInstallation(sources({ env: {} }))).toThrow(/\.env: MAIL_PASSWORD: is required by plugin "mail"/);
  });
});
