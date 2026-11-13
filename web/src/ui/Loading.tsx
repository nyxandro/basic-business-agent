import { ru } from '../i18n/ru.ts';

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

// Placeholder rows while a list loads (spec, section 7: «скелетоны»).
export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={ru.common.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
