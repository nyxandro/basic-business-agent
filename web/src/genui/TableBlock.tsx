import type { TableBlock } from '@bba/contracts';

const formatCell = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString('ru-RU');
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  return v;
};

export function TableBlockView({ block }: { block: TableBlock }) {
  return (
    <figure className="genui genui-table">
      {block.title ? <figcaption>{block.title}</figcaption> : null}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {block.columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {block.columns.map((c) => (
                  <td key={c.key}>{formatCell(row[c.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
