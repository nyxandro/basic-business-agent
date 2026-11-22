// What the card of «Да» adds for an action under a rule of multi-step approvals
// (docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 2): the stages by their names and «Зачем — увидят
// согласующие», required; «Да» becomes «Отправить на согласование», which sends «Зачем» first.
import { CHAIN_REASON_MAX, CHAIN_REASON_MIN } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { TextArea } from '../ui/Field.tsx';
import { previewChain, sendChainReason } from './api.ts';
import styles from './approvals.module.css';

export type ChainPreview = { status: 'loading' } | { status: 'none' } | { status: 'chain'; stages: string[] } | { status: 'failed' };

export function useChainPreview(tool: string): ChainPreview {
  const [preview, setPreview] = useState<ChainPreview>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    previewChain(tool).then(
      (r) => live && setPreview(r.stages ? { status: 'chain', stages: r.stages } : { status: 'none' }),
      () => live && setPreview({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [tool]);
  return preview;
}

export const reasonReady = (reason: string) => reason.trim().length >= CHAIN_REASON_MIN;

// Sends «Зачем» for the call, then the answer «Да» itself.
export async function sendForApproval(toolCallId: string, reason: string, yes: () => void | Promise<void>): Promise<void> {
  await sendChainReason(toolCallId, reason.trim());
  await yes();
}

export function ChainReason({ preview, reason, onReason }: { preview: ChainPreview; reason: string; onReason: (v: string) => void }) {
  if (preview.status === 'loading') return <p className={styles.chainNote}>{ru.chains.checking}</p>;
  if (preview.status === 'failed') return <p className={styles.chainNote}>{ru.chains.checkFailed}</p>;
  if (preview.status === 'none') return null;
  return (
    <div className={styles.chain}>
      <p className={styles.chainStages}>{ru.chains.needed(preview.stages)}</p>
      <label className={styles.chainReason}>
        <span>{ru.chains.reason}</span>
        <TextArea rows={2} maxLength={CHAIN_REASON_MAX} value={reason} onChange={(e) => onReason(e.target.value)} placeholder={ru.chains.reasonExample} />
      </label>
    </div>
  );
}
