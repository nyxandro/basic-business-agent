// A table in the chat (mockup: the deals): the first rows, «10 из 37» and «Показать все» for the rest.
import type { TableBlock } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import styles from './genui.module.css';

const ROWS_FOLDED = 10;

const formatCell = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString('ru-RU');
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  return v;
};

export function TableBlockView({ block }: { block: TableBlock }) {
  const [all, setAll] = useState(false);
  const rows = all ? block.rows : block.rows.slice(0, ROWS_FOLDED);
  // A column of numbers is aligned to the right, like money in a report.
  const numeric = new Set(block.columns.filter((c) => block.rows.length > 0 && block.rows.every((r) => typeof r[c.key] === 'number' || r[c.key] === null)).map((c) => c.key));
  return (
    <figure className={styles.block}>
      {block.title ? <figcaption className={styles.caption}>{block.title}</figcaption> : null}
      <div className={`${styles.scroll} scroll-thin`}>
        <table className={styles.table}>
          <thead>
            <tr>
              {block.columns.map((c) => (
                <th key={c.key} scope="col" className={cx(numeric.has(c.key) && styles.num)}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {block.columns.map((c) => (
                  <td key={c.key} className={cx(numeric.has(c.key) && styles.num)}>
                    {formatCell(row[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.rows.length > ROWS_FOLDED ? (
        <div className={styles.foot}>
          <span>{ru.genui.rowsOf(rows.length, block.rows.length)}</span>
          <button type="button" className={styles.more} onClick={() => setAll((v) => !v)}>
            {all ? ru.genui.fold : ru.genui.showAll}
          </button>
        </div>
      ) : null}
    </figure>
  );
}
