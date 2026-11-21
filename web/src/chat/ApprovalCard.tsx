// The confirmation card (spec, sections 7 and 8.4; mockup): what will happen, in the words of the
// tool's own description — the name of the action and the labels of its fields — then «Нет» /
// «Да, выполнить». The answer goes back to the server as the resume of the AG-UI interrupt.
import type { AgentSummary } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { IconTile, Pill } from '../ui/Display.tsx';
import styles from './chat.module.css';
import { systemOf } from './systems.ts';

const MAX_VALUE_LENGTH = 400;

export interface ApprovalInterrupt {
  metadata?: { mastra?: { toolName?: string; args?: unknown } } | Record<string, unknown>;
}

function valueText(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
}

export function ApprovalCard({ interrupt, agent, onYes, onNo }: { interrupt: ApprovalInterrupt; agent: Pick<AgentSummary, 'systems' | 'actions'>; onYes: () => void; onNo: () => void }) {
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null);
  const mastra = (interrupt.metadata as { mastra?: { toolName?: string; args?: unknown } } | undefined)?.mastra;
  const tool = mastra?.toolName ?? '';
  const system = systemOf(agent.systems, tool);
  const action = agent.actions[tool];
  const title = action?.title ?? tool;
  const args = mastra?.args && typeof mastra.args === 'object' ? Object.entries(mastra.args as Record<string, unknown>) : [];
  return (
    <div className={styles.approval} role="group" aria-label={ru.chat.confirmTitle}>
      <div className={styles.approvalHead}>
        <IconTile icon={tool.includes('mail') ? 'mail' : 'bolt'} size={32} />
        <div className={styles.approvalWho}>
          <div className={styles.approvalTitle}>{ru.chat.confirmTitle}</div>
          <div className={styles.approvalSub}>{system ? `${system} · ${title}` : title}</div>
        </div>
        <Pill tone="warn">{ru.chat.changesData}</Pill>
      </div>
      {args.length > 0 ? (
        <dl className={styles.approvalFields}>
          {args.map(([k, v]) => (
            <div key={k} className={styles.approvalField}>
              <dt>{action?.fields[k] ?? k}</dt>
              <dd>{action?.choices?.[k]?.[String(v)] ?? valueText(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {answer === 'yes' ? (
        <div className={styles.approvalRunning} role="status">
          <span className={styles.spin} />
          <span className={styles.shimmer}>{ru.chat.executingWhat(title)}</span>
        </div>
      ) : (
        <div className={styles.approvalFoot}>
          <span className={styles.approvalHint}>{ru.chat.supersedeHint}</span>
          <Button
            variant="secondary"
            disabled={answer !== null}
            onClick={() => {
              setAnswer('no');
              onNo();
            }}
          >
            {ru.chat.no}
          </Button>
          <Button
            variant="primary"
            disabled={answer !== null}
            onClick={() => {
              setAnswer('yes');
              onYes();
            }}
          >
            {ru.chat.yes}
          </Button>
        </div>
      )}
    </div>
  );
}
