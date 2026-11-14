// «Лимиты и расходы»: the limits for those with the right to change them, the spend for those with
// the right to see it — one page, its parts by rights.
import { useMe } from '../auth/session.tsx';
import { LimitsSection } from './LimitsSection.tsx';
import { hasRight } from './sections.ts';
import { UsageSection } from './UsageSection.tsx';

export function LimitsPage() {
  const me = useMe();
  return (
    <>
      {hasRight(me, 'usage') ? <UsageSection /> : null}
      {hasRight(me, 'limits') ? <LimitsSection /> : null}
    </>
  );
}
