// A formula of a widget set by KaTeX (spec, section 8.31): this module and KaTeX load with the first formula. A formula
// KaTeX cannot read shows as written, in the colour of an error.
import katex from 'katex';
import 'katex/dist/katex.min.css';
import styles from './widgets.module.css';

export default function Formula({ value, block }: { value: string; block: boolean }) {
  const html = katex.renderToString(value, { displayMode: block, throwOnError: false, output: 'htmlAndMathml', trust: false });
  const Tag = block ? 'div' : 'span';
  return <Tag className={block ? styles.formulaBlock : styles.formula} dangerouslySetInnerHTML={{ __html: html }} />;
}
