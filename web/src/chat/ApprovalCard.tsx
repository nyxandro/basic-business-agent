// The confirmation card (spec, section 7): what will happen, «Да, выполнить» / «Нет».
// The answer goes back to the server as the resume of the AG-UI interrupt.
import type { AgentSummary } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { systemOf } from './systems.ts';

const MAX_VALUE_LENGTH = 300;

export interface ApprovalInterrupt {
  metadata?: { mastra?: { toolName?: string; args?: unknown } } | Record<string, unknown>;
}

function argLines(args: unknown): [string, string][] {
  if (!args || typeof args !== 'object') return [];
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return [k, text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text];
  });
}

export function ApprovalCard({ interrupt, systems, onYes, onNo }: { interrupt: ApprovalInterrupt; systems: AgentSummary['systems']; onYes: () => void; onNo: () => void }) {
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null);
  const mastra = (interrupt.metadata as { mastra?: { toolName?: string; args?: unknown } } | undefined)?.mastra;
  const tool = mastra?.toolName ?? '';
  const system = systemOf(systems, tool);
  return (
    <div className="approval-card" role="group" aria-label={ru.chat.confirmTitle}>
      <p className="approval-title">{ru.chat.confirmTitle}</p>
      <p>{system ? `${system}: ${tool}` : tool}</p>
      <dl className="approval-args">
        {argLines(mastra?.args).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {answer === 'yes' ? <p>{ru.chat.executing}</p> : null}
      <div className="approval-buttons">
        <button type="button" className="btn" disabled={answer !== null} onClick={() => {
            setAnswer('yes');
            onYes();
          }}>
          {ru.chat.yes}
        </button>
        <button type="button" className="btn secondary" disabled={answer !== null} onClick={() => {
            setAnswer('no');
            onNo();
          }}>
          {ru.chat.no}
        </button>
      </div>
    </div>
  );
}
