// «Действия и агенты» of an MCP server (docs/specs/[20.11.2026]-mcp-connections.md, scenario 1, step 3): every action
// starts off; the admin turns on what agents may use, marks reading ones (they go without «Да»), gives a Russian
// title, picks the action that checks a personal key, sees what the turned-on actions cost every request of an
// agent, and chooses the agents.
import type { McpActionPatch, McpServerView } from '@bba/contracts';
import { useId } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Pill } from '../ui/Display.tsx';
import { Input } from '../ui/Field.tsx';
import { Switch } from '../ui/Switch.tsx';
import { Checklist } from '../ui/form-parts.tsx';
import section from './section.module.css';
import styles from './mcp.module.css';

const t = ru.mcp.admin;

export type Mark = McpActionPatch & { title: string };

export const marksOf = (server: McpServerView): Mark[] => server.actions.map((a) => ({ name: a.name, enabled: a.enabled, readOnly: a.readOnly, title: a.title ?? '', check: a.check }));

export function ActionsEditor({
  server,
  marks,
  onMarks,
  agents,
  allAgents,
  onAgents,
}: {
  server: McpServerView;
  marks: Mark[];
  onMarks: (next: Mark[]) => void;
  agents: string[];
  allAgents: { id: string; label: string }[];
  onAgents: (next: string[]) => void;
}) {
  const checkName = useId();
  const set = (name: string, patch: Partial<Mark>) => onMarks(marks.map((m) => (m.name === name ? { ...m, ...patch } : m)));
  const tokens = server.actions.filter((a) => marks.find((m) => m.name === a.name)?.enabled).reduce((sum, a) => sum + a.tokens, 0);
  const withKey = server.auth === 'personal_key' || server.auth === 'oauth';
  return (
    <>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t.actionsLegend}</legend>
        <p className={section.sub}>{t.actionsLead}</p>
        {server.actions.length === 0 ? <p className={section.note}>{t.noActions}</p> : null}
        <ul className={styles.actions}>
          {server.actions.map((action) => {
            const mark = marks.find((m) => m.name === action.name)!;
            const shown = mark.title.trim() || action.serverTitle;
            return (
              <li key={action.name} className={cx(styles.action, mark.enabled && styles.actionOn)}>
                <div className={styles.actionHead}>
                  <div className={styles.actionText}>
                    <div className={styles.actionTitle}>
                      {shown}
                      {action.isNew ? <Pill tone="accent">{t.isNew}</Pill> : null}
                      {action.isChanged ? <Pill tone="warn">{t.isChanged}</Pill> : null}
                    </div>
                    <div className={styles.actionName}>{action.name}</div>
                    {action.description ? <div className={section.sub}>{action.description}</div> : null}
                  </div>
                  <Switch checked={mark.enabled} label={t.enabledLabel(shown)} onChange={(enabled) => set(action.name, { enabled })} />
                </div>
                <div className={styles.actionMarks}>
                  <label className={styles.inlineCheck}>
                    <input type="checkbox" checked={mark.readOnly} onChange={(e) => set(action.name, { readOnly: e.target.checked, ...(e.target.checked ? {} : { check: false }) })} />
                    {t.readOnly}
                  </label>
                  {action.readOnlyHint ? <span className={styles.hint}>{t.readOnlyHint}</span> : null}
                  {withKey && mark.readOnly ? (
                    <label className={styles.inlineCheck}>
                      <input type="radio" name={checkName} checked={mark.check} onChange={() => onMarks(marks.map((m) => ({ ...m, check: m.name === action.name })))} />
                      {t.checkAction}
                    </label>
                  ) : null}
                </div>
                <Input aria-label={`${t.titleFor}: ${action.name}`} placeholder={t.titleFor} value={mark.title} onChange={(e) => set(action.name, { title: e.target.value })} />
              </li>
            );
          })}
        </ul>
        <p className={styles.tokens}>{t.tokens(tokens.toLocaleString('ru-RU'))}</p>
      </fieldset>
      <Checklist legend={t.agentsLegend} items={allAgents} selected={agents} onChange={onAgents} />
    </>
  );
}
